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

function fakeDb(state: FakeDbState): Db {
  return {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.startsWith('SELECT sweep_cursor')) {
          return {
            sweep_cursor: state.cursor,
            sweep_threads_done: state.done ?? 0,
            sweep_threads_total: state.total ?? null
          }
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
  mocks.persistThread.mockReturnValue(true)
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

    expect(mail.listThreadIds).toHaveBeenCalledWith({ pageToken: undefined })
    expect(mail.getThread).toHaveBeenCalledOnce()
    expect(mail.getThread).toHaveBeenCalledWith('old', { format: 'metadata' })
    expect(mocks.persistThread).toHaveBeenCalledWith(
      expect.anything(),
      'test@example.com',
      { id: 'old', messages: [] },
      { metadataOnly: true, inboxVisibility: 'hide' }
    )
    expect(state.cursor).toBe('done')
    expect(state.done).toBe(2)
    expect(result).toEqual({ threadCount: 2 })
    expect(events.onError).not.toHaveBeenCalled()
    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadsDone: 2, threadsTotal: 2, messagesTotal: 70 })
    )
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

    expect(listThreadIds).toHaveBeenNthCalledWith(1, { pageToken: 'expired' })
    expect(listThreadIds).toHaveBeenNthCalledWith(2, { pageToken: undefined })
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
    await expect(run).resolves.toEqual({ threadCount: 0 })
    expect(listThreadIds).toHaveBeenNthCalledWith(2, { pageToken: 'page-2' })
  })

  it('estimates remaining time from durable progress made in the current run', async () => {
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
      expect.objectContaining({ threadsDone: 1, threadsTotal: 10, etaMs: 9_000 })
    )
  })

  it('persists processed listing progress so a resumed page does not restart at zero', async () => {
    const state = {
      cursor: 'lifetime:page-2',
      threadIds: new Set<string>(),
      done: 500,
      total: 1_000 as number | null
    }
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb(state),
      provider({
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

  it('does not use the account-wide profile total for an unfiltered listing estimate', async () => {
    const events = callbacks()

    await runLifetimeSweep(
      fakeDb({ cursor: 'lifetime', threadIds: new Set<string>() }),
      provider({
        getProfile: vi.fn(async () => ({
          emailAddress: 'test@example.com',
          historyId: '101',
          threadsTotal: 50_000
        })),
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({ threadIds: [], nextPageToken: 'page-2' })
          .mockResolvedValueOnce({ threadIds: [] })
      }),
      'test@example.com',
      events,
      { requestIntervalMs: 0, pagePauseMs: 0 }
    )

    expect(events.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadsDone: 0, reason: 'quota-wait' })
    )
    const waiting = events.onProgress.mock.calls.find(([event]) => event.reason === 'quota-wait')?.[0]
    expect(waiting).not.toHaveProperty('threadsTotal')
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
