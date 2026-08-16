import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { planBackfillStart, runInboxBackfill } from './backfill'
import type { MailProvider, ThreadIdPage } from './provider'
import { ALL_MAIL_WINDOW, INBOX_BODIES_WINDOW, INBOX_METADATA_WINDOW } from './windows'

interface FakeSyncState {
  backfill_cursor: string | null
  last_history_id?: string
}

function fakeDb(state: FakeSyncState | undefined, existingThreadIds = new Set<string>()): Db {
  return {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.startsWith('SELECT backfill_cursor')) return state
        if (sql.startsWith('SELECT 1 FROM threads')) {
          return existingThreadIds.has(args[1] as string) ? { 1: 1 } : undefined
        }
        return undefined
      },
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sync_state')) {
          state = { backfill_cursor: 'metadata', last_history_id: args[1] as string }
        } else if (sql.includes('UPDATE sync_state SET backfill_cursor')) {
          if (!state) state = { backfill_cursor: null }
          state.backfill_cursor = args[0] as string
        }
        return { changes: 1 }
      }
    }),
    transaction: (fn: () => void) => fn
  } as unknown as Db
}

function emptyProvider(): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'test@example.com', historyId: '101' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async (id) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '101' })),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: `thread-${id}` } }))
  }
}

const emptyResult = { threadCount: 0, inboxThreadIds: [], spamThreadIds: [], trashThreadIds: [] }

let callbacks: { onProgress: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> }

beforeEach(() => {
  callbacks = { onProgress: vi.fn(), onError: vi.fn() }
})

describe('windowed backfill checkpoints', () => {
  it('runs inbox stages, then all-mail, spam, trash, and per-label reconciliation', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
      q: INBOX_METADATA_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, {
      q: INBOX_BODIES_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined
    })
    // No label filter: the all-mail stage subsumes the retired SENT stage.
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(3, {
      q: ALL_MAIL_WINDOW,
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(4, {
      labelIds: ['SPAM'],
      includeSpamTrash: true,
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(5, {
      labelIds: ['TRASH'],
      includeSpamTrash: true,
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(6, {
      labelIds: ['INBOX'],
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(7, {
      labelIds: ['SPAM'],
      includeSpamTrash: true,
      pageToken: undefined
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(8, {
      labelIds: ['TRASH'],
      includeSpamTrash: true,
      pageToken: undefined
    })
    expect(result).toEqual(emptyResult)
    expect(callbacks.onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: 'metadata', threadsDone: 0, mailChanged: false },
      { stage: 'bodies', threadsDone: 0, mailChanged: false },
      { stage: 'drafts', threadsDone: 0, mailChanged: false },
      { stage: 'all-mail', threadsDone: 0, mailChanged: false },
      { stage: 'spam', threadsDone: 0, mailChanged: false },
      { stage: 'trash', threadsDone: 0, mailChanged: false },
      { stage: 'reconcile', threadsDone: 0, mailChanged: false }
    ])
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('requests metadata, full, then all-mail and junk metadata snapshots', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.listThreadIds)
      .mockResolvedValueOnce({ threadIds: ['old'] })
      .mockResolvedValueOnce({ threadIds: ['recent'] })
      .mockResolvedValueOnce({ threadIds: ['archived'] })
      .mockResolvedValueOnce({ threadIds: ['junk'] })

    await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.getThread).toHaveBeenNthCalledWith(1, 'old', { format: 'metadata' })
    expect(provider.getThread).toHaveBeenNthCalledWith(2, 'recent', { format: 'full' })
    expect(provider.getThread).toHaveBeenNthCalledWith(3, 'archived', { format: 'metadata' })
    expect(provider.getThread).toHaveBeenNthCalledWith(4, 'junk', { format: 'metadata' })
  })

  it('skips threads already stored during the overlapping stages', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.listThreadIds).mockImplementation(async (options): Promise<ThreadIdPage> => {
      if (options?.q === ALL_MAIL_WINDOW && !options.labelIds) {
        return { threadIds: ['known', 'fresh'] }
      }
      return { threadIds: [] }
    })

    await runInboxBackfill(
      fakeDb({ backfill_cursor: 'all-mail', last_history_id: '88' }, new Set(['known'])),
      provider,
      callbacks
    )

    expect(provider.getThread).toHaveBeenCalledTimes(1)
    expect(provider.getThread).toHaveBeenCalledWith('fresh', { format: 'metadata' })
  })

  it('resumes directly at per-label reconciliation after the junk stages complete', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(
      fakeDb({ backfill_cursor: 'reconcile', last_history_id: '88' }),
      provider,
      callbacks
    )

    expect(provider.listThreadIds).toHaveBeenCalledTimes(3)
    expect(provider.getThread).not.toHaveBeenCalled()
    expect(result).not.toBeNull()
  })

  it('resumes the draft-id pager before continuing to the all-mail stage', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(
      fakeDb({ backfill_cursor: 'drafts:page-2', last_history_id: '88' }),
      provider,
      callbacks
    )

    expect(provider.listDrafts).toHaveBeenCalledWith('page-2')
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
      q: ALL_MAIL_WINDOW,
      pageToken: undefined
    })
    expect(result).not.toBeNull()
  })

  it('drops an expired saved page token and restarts that phase once', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.listThreadIds).mockImplementation(async (options): Promise<ThreadIdPage> => {
      if (options?.pageToken === 'expired') throw new GmailApiError(400, 'invalid page token')
      return { threadIds: [] }
    })

    const result = await runInboxBackfill(
      fakeDb({ backfill_cursor: 'metadata:expired', last_history_id: '88' }),
      provider,
      callbacks
    )

    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
      q: INBOX_METADATA_WINDOW,
      labelIds: ['INBOX'],
      pageToken: 'expired'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, {
      q: INBOX_METADATA_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined
    })
    expect(result).not.toBeNull()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('restarts a completed cursor for expired-history recovery', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.getProfile).mockRejectedValueOnce(new Error('offline'))
    const db = fakeDb({ backfill_cursor: 'done', last_history_id: '88' })

    const failed = await runInboxBackfill(db, provider, callbacks, { recovery: true })
    const recovered = await runInboxBackfill(db, provider, callbacks, { recovery: true })

    expect(failed).toBeNull()
    expect(recovered).toEqual(emptyResult)
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ q: INBOX_METADATA_WINDOW, labelIds: ['INBOX'] })
    )
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ q: INBOX_BODIES_WINDOW, labelIds: ['INBOX'] })
    )
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(3, expect.objectContaining({ q: ALL_MAIL_WINDOW }))
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ labelIds: ['SPAM'], includeSpamTrash: true })
    )
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ labelIds: ['TRASH'], includeSpamTrash: true })
    )
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({ labelIds: ['INBOX'] })
    )
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))
  })
})

describe('backfill cursor routing', () => {
  it('routes a fresh account through the full sequence', () => {
    expect(planBackfillStart(undefined)).toEqual({
      kind: 'run',
      cursor: { phase: 'metadata' },
      initialize: true
    })
  })

  it('resumes mid-backfill without resetting its checkpoint', () => {
    expect(planBackfillStart('bodies:page-2')).toEqual({
      kind: 'run',
      cursor: { phase: 'bodies', pageToken: 'page-2' },
      initialize: false
    })
    expect(planBackfillStart('drafts:page-2')).toEqual({
      kind: 'run',
      cursor: { phase: 'drafts', pageToken: 'page-2' },
      initialize: false
    })
    expect(planBackfillStart('all-mail:page-3')).toEqual({
      kind: 'run',
      cursor: { phase: 'all-mail', pageToken: 'page-3' },
      initialize: false
    })
    expect(planBackfillStart('spam:page-1')).toEqual({
      kind: 'run',
      cursor: { phase: 'spam', pageToken: 'page-1' },
      initialize: false
    })
    expect(planBackfillStart('trash:page-1')).toEqual({
      kind: 'run',
      cursor: { phase: 'trash', pageToken: 'page-1' },
      initialize: false
    })
    expect(planBackfillStart('reconcile')).toEqual({
      kind: 'run',
      cursor: { phase: 'reconcile' },
      initialize: false
    })
  })

  it('routes a retired sent cursor to the all-mail stage without its page token', () => {
    expect(planBackfillStart('sent')).toEqual({
      kind: 'run',
      cursor: { phase: 'all-mail' },
      initialize: false
    })
    expect(planBackfillStart('sent:page-3')).toEqual({
      kind: 'run',
      cursor: { phase: 'all-mail' },
      initialize: false
    })
  })

  it('skips a completed account but still restarts it for history recovery', () => {
    expect(planBackfillStart('done')).toEqual({ kind: 'skip' })
    expect(planBackfillStart('done', true)).toEqual({
      kind: 'run',
      cursor: { phase: 'metadata' },
      initialize: true
    })
  })
})
