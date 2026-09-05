import { describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { fakeMailProvider } from '../testing/fakes'
import { type AttachmentFlagCallbacks, runAttachmentFlagWalk } from './attachmentFlags'

const ACCOUNT = 'me@example.com'

interface StoredThread {
  id: string
  hasAttachment?: boolean
}

function store(threads: StoredThread[], cursor: string | null = null): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(ACCOUNT, ACCOUNT)
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

function callbacks(): AttachmentFlagCallbacks & {
  onProgress: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onProgress: vi.fn(), onError: vi.fn() }
}

const NO_PAUSE = { pagePauseMs: 0, foregroundYieldMs: 0 }

describe('attachment flag cursor routing', () => {
  it('costs nothing once the pass is done', async () => {
    const db = store([{ id: 't1' }], 'done')
    const listThreadIds = vi.fn()

    await expect(
      runAttachmentFlagWalk(db, fakeMailProvider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
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
      runAttachmentFlagWalk(db, fakeMailProvider({ listThreadIds, getThread }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 1 })

    // Only t1 changes: t2 already knew, t3 was not listed, and a thread the
    // store has never seen is not invented here.
    expect(flags(db)).toEqual({ t1: 1, t2: 1, t3: 0 })
    expect(getThread).not.toHaveBeenCalled()
    expect(listThreadIds).toHaveBeenCalledWith({
      q: 'has:attachment',
      pageToken: undefined,
      priority: 'background'
    })
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
      runAttachmentFlagWalk(db, fakeMailProvider({ listThreadIds }), ACCOUNT, events, NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 0 })

    // t2 is absent from the listing, which is not evidence: the listing skips
    // Spam and Trash and answers from Gmail's own index.
    expect(flags(db)).toEqual({ t1: 1, t2: 1 })
    expect(events.onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ mailChanged: true }))
  })

  it('is idempotent across a rerun of the same listing', async () => {
    const db = store([{ id: 't1' }], 'attachments')
    const listThreadIds = vi.fn(async () => ({ threadIds: ['t1'] }))

    await runAttachmentFlagWalk(db, fakeMailProvider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    db.prepare('UPDATE sync_state SET attachment_cursor = ? WHERE account_id = ?').run('attachments', ACCOUNT)
    await expect(
      runAttachmentFlagWalk(db, fakeMailProvider({ listThreadIds }), ACCOUNT, callbacks(), NO_PAUSE)
    ).resolves.toEqual({ threadsFlagged: 0 })
    expect(flags(db)).toEqual({ t1: 1 })
  })
})
