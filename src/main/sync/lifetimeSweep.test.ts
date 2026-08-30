import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { systemTime } from '../time'
import { type LifetimeSweepCallbacks, planLifetimeSweepStart, runLifetimeSweep } from './lifetimeSweep'
import type { MailProvider } from './provider'

const mocks = vi.hoisted(() => ({ persistThread: vi.fn() }))

vi.mock('./persist', () => ({ persistThread: mocks.persistThread }))

interface FakeDbState {
  cursor: string | null
  threadIds: Set<string>
  done?: number
  total?: number | null
}

const fakeDbStates = new WeakMap<Db, FakeDbState>()

function fakeDb(state: FakeDbState): Db {
  const db = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.startsWith('SELECT sweep_cursor')) {
          return {
            sweep_cursor: state.cursor,
            sweep_threads_done: state.done ?? 0,
            sweep_threads_total: state.total ?? null
          }
        }
        if (sql.startsWith('SELECT COUNT(*) AS count FROM threads')) {
          return { count: state.threadIds.size }
        }
        if (sql.startsWith('SELECT 1 FROM threads')) {
          return state.threadIds.has(args[1] as string) ? { 1: 1 } : undefined
        }
        return undefined
      },
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE sync_state')) {
          state.cursor = args[0] as string
          state.done = args[1] as number
          state.total = args[2] as number | null
        }
        return { changes: 1 }
      }
    })
  } as unknown as Db
  fakeDbStates.set(db, state)
  return db
}

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({
      emailAddress: 'test@example.com',
      historyId: '101',
      threadsTotal: 50,
      messagesTotal: 70
    })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async (id) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '101' })),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: `thread-${id}` } })),
    ...overrides
  }
}

function callbacks(): LifetimeSweepCallbacks & {
  onProgress: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onProgress: vi.fn(), onError: vi.fn() }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  mocks.persistThread.mockReset()
})

beforeEach(() => {
  mocks.persistThread.mockImplementation((db: Db, _accountId: string, thread: GmailThread) => {
    fakeDbStates.get(db)?.threadIds.add(thread.id)
    return true
  })
})

describe('lifetime sweep cursor routing', () => {
  it('routes fresh, resumed, and completed cursors', () => {
    expect(planLifetimeSweepStart(null)).toEqual({ kind: 'run', initialize: true })
    expect(planLifetimeSweepStart('lifetime')).toEqual({ kind: 'run', initialize: false })
    expect(planLifetimeSweepStart('lifetime:page-2')).toEqual({
      kind: 'run',
      pageToken: 'page-2',
      initialize: false
    })
    expect(planLifetimeSweepStart('done')).toEqual({ kind: 'skip' })
    expect(planLifetimeSweepStart('capped:lifetime')).toEqual({ kind: 'run', initialize: false })
    expect(planLifetimeSweepStart('capped:lifetime:page-2')).toEqual({
      kind: 'run',
      pageToken: 'page-2',
      initialize: false
    })
    expect(() => planLifetimeSweepStart('sent:page-2')).toThrow('Invalid lifetime sweep cursor')
  })
})

describe('lifetime header indexing', () => {
  it('uses an unfiltered listing, skips stored ids, and fetches metadata only', async () => {
    const state: FakeDbState = { cursor: null, threadIds: new Set(['stored']) }
    const mail = provider({
      listThreadIds: vi.fn(async () => ({ threadIds: ['stored', 'old'] })),
      getThread: vi.fn(async (id) => ({ id, messages: [] }))
    })
    const events = callbacks()

    const result = await runLifetimeSweep(fakeDb(state), mail, 'test@example.com', events, {
      requestIntervalMs: 0,
      pagePauseMs: 0
    })

    expect(mail.listThreadIds).toHaveBeenCalledWith({
      pageToken: undefined,
      priority: 'background'
    })
    expect(mail.getThread).toHaveBeenCalledOnce()
    expect(mail.getThread).toHaveBeenCalledWith('old', {
      format: 'metadata',
      priority: 'background'
    })
    expect(mocks.persistThread).toHaveBeenCalledWith(
      expect.anything(),
      'test@example.com',
      { id: 'old', messages: [] },
      { metadataOnly: true, inboxVisibility: 'hide' }
    )
    expect(state.cursor).toBe('done')
    expect(state.done).toBe(2)
    expect(result).toMatchObject({ threadCount: 2, quotaWaitMs: 0 })
    expect(events.onError).not.toHaveBeenCalled()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadsDone: 2, threadsTotal: 50, messagesTotal: 70 })
    )
  })

  it('stops at the conversation cap without discarding its cursor or making requests', async () => {
    // The walk is newest first, so a cap keeps the newest conversations and
    // leaves the rest to server search. Two already stored, cap of two: the
    // third must never be fetched.
    const state: FakeDbState = { cursor: null, threadIds: new Set(['newest', 'next']) }
    const mail = provider({
      listThreadIds: vi.fn(async () => ({ threadIds: ['newest', 'next', 'older'] })),
      getThread: vi.fn(async (id) => ({ id, messages: [] }))
    })
    const events = callbacks()

    const result = await runLifetimeSweep(fakeDb(state), mail, 'test@example.com', events, {
      requestIntervalMs: 0,
      pagePauseMs: 0,
      threadCap: 2
    })

    expect(mail.getThread).not.toHaveBeenCalled()
    expect(mail.getProfile).not.toHaveBeenCalled()
    expect(mail.listThreadIds).not.toHaveBeenCalled()
    expect(mocks.persistThread).not.toHaveBeenCalled()
    expect(state.cursor).toBe('capped:lifetime')
    expect(result).toMatchObject({ threadCount: 0 })
    expect(events.onError).not.toHaveBeenCalled()
  })

  it.each([4, 0])(
    'resumes a partial page when the cap changes to %i without double-counting ids',
    async (cap) => {
      const state = { cursor: 'lifetime:page-2', threadIds: new Set(['first', 'second']), done: 2 }
      const db = fakeDb(state)
      const mail = provider({
        listThreadIds: vi.fn(async ({ pageToken } = {}) =>
          pageToken === 'page-2'
            ? { threadIds: ['third', 'fourth'], nextPageToken: 'page-3' }
            : { threadIds: ['fifth'] }
        )
      })
      const events = callbacks()
      const run = (threadCap: number) =>
        runLifetimeSweep(db, mail, 'test@example.com', events, {
          threadCap,
          requestIntervalMs: 0,
          pagePauseMs: 0
        })

      await run(3)
      expect(state.threadIds).toEqual(new Set(['first', 'second', 'third']))
      expect(state.cursor).toBe('capped:lifetime:page-2')
      expect(state.done).toBe(2)
      vi.mocked(mail.getThread).mockClear()
      vi.mocked(mail.listThreadIds).mockClear()
      vi.mocked(mail.getProfile).mockClear()
      await run(3)
      await run(2)
      expect(mail.getThread).not.toHaveBeenCalled()
      expect(mail.listThreadIds).not.toHaveBeenCalled()
      expect(mail.getProfile).not.toHaveBeenCalled()

      await run(cap)
      expect(mail.listThreadIds).toHaveBeenNthCalledWith(1, {
        pageToken: 'page-2',
        priority: 'background'
      })
      expect(vi.mocked(mail.getThread).mock.calls.map(([id]) => id)).toEqual(
        cap === 0 ? ['fourth', 'fifth'] : ['fourth']
      )
      expect(state.done).toBe(cap === 0 ? 5 : 4)
      expect(state.cursor).toBe(cap === 0 ? 'done' : 'capped:lifetime:page-3')
      expect(events.onError).not.toHaveBeenCalled()
    }
  )

  it('stores the whole account when the cap is disabled', async () => {
    const state: FakeDbState = { cursor: null, threadIds: new Set(['stored']) }
    const mail = provider({
      listThreadIds: vi.fn(async () => ({ threadIds: ['stored', 'older'] })),
      getThread: vi.fn(async (id) => ({ id, messages: [] }))
    })

    await runLifetimeSweep(fakeDb(state), mail, 'test@example.com', callbacks(), {
      requestIntervalMs: 0,
      pagePauseMs: 0,
      threadCap: 0
    })

    expect(mail.getThread).toHaveBeenCalledWith('older', expect.anything())
  })

  it('resumes from the durable page token and restarts an expired token once', async () => {
    const state = { cursor: 'lifetime:expired', threadIds: new Set<string>() }
    const listThreadIds = vi
      .fn()
      .mockRejectedValueOnce(new GmailApiError(400, 'invalid page token'))
      .mockResolvedValueOnce({ threadIds: [] })
    const mail = provider({ listThreadIds })

    await runLifetimeSweep(fakeDb(state), mail, 'test@example.com', callbacks(), {
      requestIntervalMs: 0,
      pagePauseMs: 0
    })

    expect(listThreadIds).toHaveBeenNthCalledWith(1, {
      pageToken: 'expired',
      priority: 'background'
    })
    expect(listThreadIds).toHaveBeenNthCalledWith(2, {
      pageToken: undefined,
      priority: 'background'
    })
    expect(state.cursor).toBe('done')
  })

  it('does not write or advance the cursor after cancellation during a metadata request', async () => {
    let resolveThread!: (thread: GmailThread) => void
    const thread = new Promise<GmailThread>((resolve) => {
      resolveThread = resolve
    })
    let active = true
    const state = { cursor: 'lifetime', threadIds: new Set<string>() }
    const mail = provider({
      listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
      getThread: vi.fn(() => thread)
    })

    const run = runLifetimeSweep(fakeDb(state), mail, 'test@example.com', callbacks(), {
      requestIntervalMs: 0,
      pagePauseMs: 0,
      shouldContinue: () => active
    })
    await flush()
    active = false
    resolveThread({ id: 'old', messages: [] })

    await expect(run).resolves.toBeNull()
    expect(mocks.persistThread).not.toHaveBeenCalled()
    expect(state.cursor).toBe('lifetime')
  })

  it('paces page requests and yields repeatedly to foreground work on injected time', async () => {
    vi.useFakeTimers()
    let foregroundBusy = true
    const state = { cursor: 'lifetime', threadIds: new Set<string>() }
    const listThreadIds = vi
      .fn()
      .mockResolvedValueOnce({ threadIds: [], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ threadIds: [] })
    const events = callbacks()
    const run = runLifetimeSweep(fakeDb(state), provider({ listThreadIds }), 'test@example.com', events, {
      requestIntervalMs: 100,
      pagePauseMs: 1_000,
      foregroundYieldMs: 250,
      shouldYield: () => foregroundBusy
    })

    await flush()
    expect(listThreadIds).not.toHaveBeenCalled()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'foreground-yield', waitMs: 250 })
    )

    foregroundBusy = false
    await vi.advanceTimersByTimeAsync(250)
    expect(listThreadIds).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(99)
    expect(listThreadIds).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listThreadIds).toHaveBeenCalledOnce()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'quota-wait', waitMs: 1_000 })
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(listThreadIds).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(run).resolves.toMatchObject({ threadCount: 0, quotaWaitMs: 0 })
    expect(listThreadIds).toHaveBeenNthCalledWith(2, {
      pageToken: 'page-2',
      priority: 'background'
    })
  })

  it('estimates remaining time from metadata indexing, excluding listing work', async () => {
    let now = 0
    const state = { cursor: 'lifetime', threadIds: new Set<string>() }
    mocks.persistThread.mockImplementation((_db, _accountId, thread: GmailThread) => {
      state.threadIds.add(thread.id)
      return true
    })
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb(state),
      provider({
        getProfile: vi.fn(async () => {
          now = 100
          return {
            emailAddress: 'test@example.com',
            historyId: '101',
            threadsTotal: 10
          }
        }),
        listThreadIds: vi
          .fn()
          .mockImplementationOnce(async () => {
            now = 200
            return { threadIds: ['old'], nextPageToken: 'page-2', resultSizeEstimate: 10 }
          })
          .mockResolvedValueOnce({ threadIds: [] }),
        getThread: vi.fn(async () => {
          now = 1_000
          return { id: 'old', messages: [] }
        })
      }),
      'test@example.com',
      events,
      {
        time: { now: () => now, timers: systemTime.timers },
        requestIntervalMs: 0,
        pagePauseMs: 0
      }
    )

    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        threadsDone: 1,
        threadsTotal: 10,
        etaMs: 7_200,
        elapsedMs: 1_000,
        threadsPerMinute: 60
      })
    )
  })

  it('reports actual weighted-limiter wait separately from the sweep duty cycle', async () => {
    let quotaWaitMs = 0
    const events = callbacks()
    const mail = provider({
      listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
      getThread: vi.fn(async (id) => {
        quotaWaitMs = 250
        return { id, messages: [] }
      }),
      quotaMetrics: () => ({ requests: 2, units: 50, waitMs: quotaWaitMs })
    })

    const result = await runLifetimeSweep(
      fakeDb({ cursor: 'lifetime', threadIds: new Set<string>() }),
      mail,
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(result).toMatchObject({ threadCount: 1, quotaWaitMs: 250 })
    expect(events.onProgress).toHaveBeenCalledWith(expect.objectContaining({ quotaWaitMs: 250 }))
  })

  it('does not count a foreground write that lands during a metadata request as sweep throughput', async () => {
    const state = { cursor: 'lifetime', threadIds: new Set<string>() }
    let resolveThread: ((thread: GmailThread) => void) | undefined
    const getThread = vi.fn(
      () =>
        new Promise<GmailThread>((resolve) => {
          resolveThread = resolve
        })
    )
    const events = callbacks()

    const run = runLifetimeSweep(
      fakeDb(state),
      provider({
        getProfile: vi.fn(async () => ({
          emailAddress: 'test@example.com',
          historyId: '101',
          threadsTotal: 10
        })),
        listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
        getThread
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    await vi.waitFor(() => expect(getThread).toHaveBeenCalledOnce())
    state.threadIds.add('old')
    resolveThread?.({ id: 'old', messages: [] })

    await expect(run).resolves.toMatchObject({ threadCount: 1 })
    expect(mocks.persistThread).not.toHaveBeenCalled()
    expect(events.onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadsDone: 1, threadsTotal: 10 })
    )
    expect(events.onProgress.mock.calls.every(([event]) => event.etaMs === undefined)).toBe(true)
  })

  it('persists processed listing progress so a resumed page does not restart at zero', async () => {
    const existingIds = Array.from({ length: 500 }, (_, index) => `stored-${index}`)
    const state = {
      cursor: 'lifetime:page-2',
      threadIds: new Set(existingIds),
      done: 500,
      total: 1_000 as number | null
    }
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb(state),
      provider({
        getProfile: vi.fn(async () => ({
          emailAddress: 'test@example.com',
          historyId: '101',
          threadsTotal: 1_000
        })),
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({ threadIds: [], nextPageToken: 'page-3' })
          .mockResolvedValueOnce({ threadIds: [] })
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadsDone: 500, threadsTotal: 1_000 })
    )
    expect(state.cursor).toBe('done')
    expect(state.done).toBe(500)
  })

  it('uses the account total and unique local rows instead of a page result estimate', async () => {
    const events = callbacks()
    const threadIds = new Set(['stage-one', 'all-mail', 'spam'])

    await runLifetimeSweep(
      fakeDb({ cursor: 'lifetime', threadIds }),
      provider({
        getProfile: vi.fn(async () => ({
          emailAddress: 'test@example.com',
          historyId: '101',
          threadsTotal: 50_000
        })),
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({
            threadIds: [],
            nextPageToken: 'page-2',
            resultSizeEstimate: 201
          })
          .mockResolvedValueOnce({ threadIds: [] })
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        threadsDone: 3,
        threadsTotal: 50_000,
        reason: 'quota-wait'
      })
    )
    const waiting = events.onProgress.mock.calls.find(([event]) => event.reason === 'quota-wait')?.[0]
    expect(waiting.threadsTotal).not.toBe(201)
  })

  it('keeps progress indeterminate when the account profile omits its thread total', async () => {
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb({ cursor: 'lifetime', threadIds: new Set(['stored']) }),
      provider({
        getProfile: vi.fn(async () => ({
          emailAddress: 'test@example.com',
          historyId: '101'
        })),
        listThreadIds: vi.fn(async () => ({ threadIds: [], resultSizeEstimate: 201 }))
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadsDone: 1, reason: 'running' })
    )
    expect(events.onProgress.mock.calls.every(([event]) => !('threadsTotal' in event))).toBe(true)
  })

  it('does not expose hidden persistence as a visible-mail change signal', async () => {
    mocks.persistThread.mockReturnValue(true)
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb({ cursor: 'lifetime', threadIds: new Set<string>() }),
      provider({
        listThreadIds: vi.fn(async () => ({ threadIds: ['chat'] })),
        getThread: vi.fn(async () => ({ id: 'chat', messages: [] }))
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(events.onProgress.mock.calls.every(([event]) => !('mailChanged' in event))).toBe(true)
  })
})
