import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { SchedulerTime, TimerHandle } from '../time'
import { planBackfillStart, runInboxBackfill } from './backfill'
import type { MailProvider, ThreadIdPage } from './provider'
import { ALL_MAIL_WINDOW, INBOX_BODIES_WINDOW, INBOX_METADATA_WINDOW } from './tuning'

interface FakeSyncState {
  backfill_cursor: string | null
  last_history_id?: string
}

function fakeDb(state: FakeSyncState | undefined, existingThreadIds = new Set<string>()): Db {
  return {
    prepare: (sql: string) => ({
      all: () => [],
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
  it('reports first-readable, per-stage rate, processed count, and real quota-wait deltas', async () => {
    let now = 0
    let quotaWaitMs = 0
    const advance = (elapsedMs: number, waitedMs = 0): void => {
      now += elapsedMs
      quotaWaitMs += waitedMs
    }
    const time: SchedulerTime = {
      now: () => now,
      timers: {
        setTimeout: () => 1 as unknown as TimerHandle,
        clearTimeout: () => {}
      }
    }
    const provider = emptyProvider()
    vi.mocked(provider.getProfile).mockImplementation(async () => {
      advance(100, 1)
      return { emailAddress: 'test@example.com', historyId: '101' }
    })
    vi.mocked(provider.listLabels).mockImplementation(async () => {
      advance(100, 1)
      return []
    })
    vi.mocked(provider.listThreadIds).mockImplementation(async (options) => {
      advance(100, 5)
      if (options?.q === INBOX_METADATA_WINDOW && options.labelIds?.[0] === 'INBOX') {
        return { threadIds: ['new'], resultSizeEstimate: 1 }
      }
      if (options?.labelIds?.[0] === 'INBOX' && options.q === undefined) {
        return { threadIds: ['new'], resultSizeEstimate: 1 }
      }
      return { threadIds: [], resultSizeEstimate: 0 }
    })
    vi.mocked(provider.getThread).mockImplementation(async (id) => {
      advance(200, 20)
      return { id, messages: [] }
    })
    provider.quotaMetrics = () => ({ requests: 0, units: 0, waitMs: quotaWaitMs })
    const onProgress = vi.fn()
    const onMetric = vi.fn()

    const result = await runInboxBackfill(
      fakeDb(undefined),
      provider,
      { onProgress, onError: vi.fn(), onMetric },
      { time }
    )

    expect(result?.threadCount).toBe(1)
    expect(
      onProgress.mock.calls.map(([progress]) => progress).find((progress) => progress.firstReadableMs)
    ).toEqual(
      expect.objectContaining({
        stage: 'metadata',
        stageThreadsListed: 1,
        stageThreadsFetched: 1,
        stageThreadsEstimate: 1,
        firstReadableMs: 500,
        stageListedPerMinute: 200,
        stageFetchedPerMinute: 200,
        quotaWaitMs: 27
      })
    )
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stage-complete',
        stage: 'metadata',
        threadsListed: 1,
        threadsFetched: 1,
        threadsEstimate: 1,
        elapsedMs: 300,
        threadsPerMinute: 200,
        quotaWaitMs: 25,
        firstReadableMs: 500,
        interactiveReadyMs: 500
      })
    )
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stage-complete',
        stage: 'reconcile',
        threadsListed: 1,
        threadsFetched: 0
      })
    )
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'complete',
        threadsDone: 1,
        firstReadableMs: 500,
        interactiveReadyMs: 500
      })
    )
  })

  it('runs inbox stages, then all-mail, spam, trash, and per-label reconciliation', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
      q: INBOX_METADATA_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined,
      priority: 'foreground'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, {
      q: INBOX_BODIES_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined,
      priority: 'background'
    })
    // No label filter: the all-mail stage subsumes the retired SENT stage.
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(3, {
      q: ALL_MAIL_WINDOW,
      pageToken: undefined,
      priority: 'background'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(4, {
      labelIds: ['SPAM'],
      includeSpamTrash: true,
      pageToken: undefined,
      priority: 'background'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(5, {
      labelIds: ['TRASH'],
      includeSpamTrash: true,
      pageToken: undefined,
      priority: 'background'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(6, {
      labelIds: ['INBOX'],
      pageToken: undefined,
      priority: 'background'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(7, {
      labelIds: ['SPAM'],
      includeSpamTrash: true,
      pageToken: undefined,
      priority: 'background'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(8, {
      labelIds: ['TRASH'],
      includeSpamTrash: true,
      pageToken: undefined,
      priority: 'background'
    })
    expect(result).toEqual(emptyResult)
    expect(
      callbacks.onProgress.mock.calls.map(([progress]) => ({
        stage: progress.stage,
        threadsDone: progress.threadsDone,
        mailChanged: progress.mailChanged
      }))
    ).toEqual([
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

    expect(provider.getThread).toHaveBeenNthCalledWith(1, 'old', {
      format: 'metadata',
      priority: 'foreground'
    })
    expect(provider.getThread).toHaveBeenNthCalledWith(2, 'recent', {
      format: 'full',
      priority: 'background'
    })
    expect(provider.getThread).toHaveBeenNthCalledWith(3, 'archived', {
      format: 'metadata',
      priority: 'background'
    })
    expect(provider.getThread).toHaveBeenNthCalledWith(4, 'junk', {
      format: 'metadata',
      priority: 'background'
    })
  })

  it('skips threads already stored during the overlapping stages', async () => {
    const provider = emptyProvider()
    const onMetric = vi.fn()
    vi.mocked(provider.listThreadIds).mockImplementation(async (options): Promise<ThreadIdPage> => {
      if (options?.q === ALL_MAIL_WINDOW && !options.labelIds) {
        return { threadIds: ['known', 'fresh'], resultSizeEstimate: 2 }
      }
      return { threadIds: [] }
    })

    await runInboxBackfill(
      fakeDb({ backfill_cursor: 'all-mail', last_history_id: '88' }, new Set(['known'])),
      provider,
      { ...callbacks, onMetric }
    )

    expect(provider.getThread).toHaveBeenCalledTimes(1)
    expect(provider.getThread).toHaveBeenCalledWith('fresh', {
      format: 'metadata',
      priority: 'background'
    })
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stage-complete',
        stage: 'all-mail',
        threadsListed: 2,
        threadsFetched: 1,
        threadsEstimate: 2
      })
    )
  })

  it('stops the page after one thread fails instead of draining the rest', async () => {
    const provider = emptyProvider()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(provider.listThreadIds).mockImplementation(async (options): Promise<ThreadIdPage> => {
      if (options?.q === ALL_MAIL_WINDOW && !options.labelIds) {
        return { threadIds: ['boom', 't2', 't3', 't4', 't5', 't6'] }
      }
      return { threadIds: [] }
    })
    vi.mocked(provider.getThread).mockImplementation(async (id) => {
      if (id === 'boom') throw new GmailApiError(500, 'backend error', true)
      await held
      return { id, messages: [] }
    })

    const run = runInboxBackfill(
      fakeDb({ backfill_cursor: 'all-mail', last_history_id: '88' }),
      provider,
      callbacks
    )
    await vi.waitFor(() => expect(provider.getThread).toHaveBeenCalledTimes(3))
    release()

    await expect(run).resolves.toBeNull()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.any(GmailApiError))
    // The three workers in flight finish what they hold; nothing else is
    // fetched behind a rejection the caller has already seen.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.getThread).toHaveBeenCalledTimes(3)
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

    expect(provider.listDrafts).toHaveBeenCalledWith('page-2', { priority: 'background' })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
      q: ALL_MAIL_WINDOW,
      pageToken: undefined,
      priority: 'background'
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
      pageToken: 'expired',
      priority: 'foreground'
    })
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, {
      q: INBOX_METADATA_WINDOW,
      labelIds: ['INBOX'],
      pageToken: undefined,
      priority: 'foreground'
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

  it('rejects cursors that are not in the ordered backfill phase list', () => {
    expect(() => planBackfillStart('unknown')).toThrow('Invalid backfill cursor: unknown')
    expect(() => planBackfillStart('reconcile:page-1')).toThrow('Invalid backfill cursor: reconcile:page-1')
  })
})
