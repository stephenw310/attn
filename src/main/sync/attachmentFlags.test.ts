import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import {
  type AttachmentFlagCallbacks,
  planAttachmentFlagStart,
  runAttachmentFlagWalk
} from './attachmentFlags'
import type { MailProvider } from './provider'

const ACCOUNT = 'me@example.com'

interface StoredThread {
  id: string
  hasAttachment?: boolean
}

function store(threads: StoredThread[], cursor: string | null = null): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(ACCOUNT, ACCOUNT, 1)
  db.prepare('INSERT INTO sync_state (account_id, attachment_cursor) VALUES (?, ?)').run(ACCOUNT, cursor)
  const insert = db.prepare(
    'INSERT INTO threads (account_id, id, last_msg_at, has_attachment) VALUES (?, ?, ?, ?)'
  )
  for (const thread of threads) insert.run(ACCOUNT, thread.id, 1, thread.hasAttachment ? 1 : 0)
  return db
}

function flags(db: Db): Record<string, number> {
  const rows = db
    .prepare('SELECT id, has_attachment FROM threads WHERE account_id = ? ORDER BY id')
    .all(ACCOUNT) as { id: string; has_attachment: number }[]
  return Object.fromEntries(rows.map((row) => [row.id, row.has_attachment]))
}

function cursor(db: Db): string | null {
  return (
    db.prepare('SELECT attachment_cursor FROM sync_state WHERE account_id = ?').get(ACCOUNT) as {
      attachment_cursor: string | null
    }
  ).attachment_cursor
}

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: ACCOUNT, historyId: '1' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async (id) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '1' })),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: `thread-${id}` } })),
    ...overrides
  }
}

function callbacks(): AttachmentFlagCallbacks & {
  onProgress: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onProgress: vi.fn(), onError: vi.fn() }
}

const NO_PAUSE = { pagePauseMs: 0, foregroundYieldMs: 0 }

afterEach(() => {
  vi.useRealTimers()
})

describe('attachment flag cursor routing', () => {
  it('routes fresh, resumed, and completed cursors', () => {
    expect(planAttachmentFlagStart(null)).toEqual({ kind: 'run' })
    expect(planAttachmentFlagStart('attachments')).toEqual({ kind: 'run' })
    expect(planAttachmentFlagStart('attachments:page-2')).toEqual({ kind: 'run', pageToken: 'page-2' })
    expect(planAttachmentFlagStart('done')).toEqual({ kind: 'skip' })
    expect(() => planAttachmentFlagStart('lifetime:page-2')).toThrow(/Invalid attachment flag cursor/)
  })

  it('costs nothing once the pass is done', async () => {
    const db = store([{ id: 't1' }], 'done')
    const listThreadIds = vi.fn()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 0 })
    expect(listThreadIds).not.toHaveBeenCalled()
    expect(cursor(db)).toBe('done')
  })
})

describe('attachment flag walk', () => {
  it('raises the flag on stored threads only, without fetching any thread', async () => {
    const db = store([{ id: 't1' }, { id: 't2', hasAttachment: true }, { id: 't3' }])
    const listThreadIds = vi.fn(async () => ({ threadIds: ['t1', 't2', 'unknown-thread'] }))
    const getThread = vi.fn()
    const events = callbacks()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds, getThread }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 1 })

    // Only t1 changes: t2 already knew, t3 was not listed, and a thread the
    // store has never seen is not invented here.
    expect(flags(db)).toEqual({ t1: 1, t2: 1, t3: 0 })
    expect(getThread).not.toHaveBeenCalled()
    expect(listThreadIds).toHaveBeenCalledWith({ q: 'has:attachment', pageToken: undefined })
    expect(cursor(db)).toBe('done')
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'running', threadsFlagged: 1, mailChanged: true })
    )
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('never lowers a flag the store already holds', async () => {
    const db = store([
      { id: 't1', hasAttachment: true },
      { id: 't2', hasAttachment: true }
    ])
    const listThreadIds = vi.fn(async () => ({ threadIds: ['t1'] }))
    const events = callbacks()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 0 })

    // t2 is absent from the listing, which is not evidence: the listing skips
    // Spam and Trash and answers from Gmail's own index.
    expect(flags(db)).toEqual({ t1: 1, t2: 1 })
    expect(events.onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ mailChanged: true }))
  })

  it('is idempotent across a rerun of the same listing', async () => {
    const db = store([{ id: 't1' }], 'attachments')
    const listThreadIds = vi.fn(async () => ({ threadIds: ['t1'] }))

    await runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    db.prepare('UPDATE sync_state SET attachment_cursor = ? WHERE account_id = ?').run('attachments', ACCOUNT)
    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 0 })
    expect(flags(db)).toEqual({ t1: 1 })
  })

  it('resumes from the durable page token and checkpoints each page', async () => {
    const db = store([{ id: 't1' }, { id: 't2' }], 'attachments:page-2')
    const listThreadIds = vi
      .fn()
      .mockResolvedValueOnce({ threadIds: ['t1'], nextPageToken: 'page-3' })
      .mockResolvedValueOnce({ threadIds: ['t2'] })

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 2 })

    expect(listThreadIds).toHaveBeenNthCalledWith(1, { q: 'has:attachment', pageToken: 'page-2' })
    expect(listThreadIds).toHaveBeenNthCalledWith(2, { q: 'has:attachment', pageToken: 'page-3' })
    expect(flags(db)).toEqual({ t1: 1, t2: 1 })
    expect(cursor(db)).toBe('done')
  })

  it('restarts the phase once when a saved page token has expired', async () => {
    const db = store([{ id: 't1' }], 'attachments:stale')
    const listThreadIds = vi
      .fn()
      .mockRejectedValueOnce(new GmailApiError(400, 'invalid page token'))
      .mockResolvedValueOnce({ threadIds: ['t1'] })
    const events = callbacks()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 1 })

    expect(listThreadIds).toHaveBeenNthCalledWith(2, { q: 'has:attachment', pageToken: undefined })
    expect(events.onError).not.toHaveBeenCalled()
    expect(cursor(db)).toBe('done')
  })

  it('reports a failure without advancing the cursor', async () => {
    const db = store([{ id: 't1' }], 'attachments')
    const listThreadIds = vi.fn(async () => {
      throw new GmailApiError(429, 'quota', true)
    })
    const events = callbacks()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toBeNull()
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }))
    expect(cursor(db)).toBe('attachments')
    expect(flags(db)).toEqual({ t1: 0 })
  })

  it('stops writing as soon as the run is cancelled', async () => {
    const db = store([{ id: 't1' }])
    let live = true
    const listThreadIds = vi.fn(async () => {
      live = false
      return { threadIds: ['t1'] }
    })
    const events = callbacks()

    await expect(
      runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, events, {
        ...NO_PAUSE,
        shouldContinue: () => live
      })
    ).resolves.toBeNull()

    expect(flags(db)).toEqual({ t1: 0 })
    expect(cursor(db)).toBeNull()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('yields to foreground work and paces page boundaries on injected time', async () => {
    vi.useFakeTimers()
    let foregroundBusy = true
    const db = store([{ id: 't1' }, { id: 't2' }])
    const listThreadIds = vi
      .fn()
      .mockResolvedValueOnce({ threadIds: ['t1'], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ threadIds: ['t2'] })
    const events = callbacks()
    const run = runAttachmentFlagWalk(db, provider({ listThreadIds }), ACCOUNT, events, {
      pagePauseMs: 1_000,
      foregroundYieldMs: 250,
      shouldYield: () => foregroundBusy
    })

    await Promise.resolve()
    expect(listThreadIds).not.toHaveBeenCalled()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'foreground-yield', waitMs: 250 })
    )

    foregroundBusy = false
    await vi.advanceTimersByTimeAsync(250)
    expect(listThreadIds).toHaveBeenCalledOnce()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'quota-wait', waitMs: 1_000 })
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(listThreadIds).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(run).resolves.toEqual({ threadsFlagged: 2 })
  })
})
