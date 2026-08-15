import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncState } from '../shared/mail'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import type { GmailMailProvider } from './gmail/provider'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import type { SnoozeScheduler } from './scheduler'
import type { BackfillCallbacks, BackfillResult } from './sync/backfill'
import type { HistoryPollerOptions } from './sync/poller'

const mocks = vi.hoisted(() => {
  class FakePoller {
    started = false
    stopped = false
    readonly runNowRequests: Array<() => void> = []
    constructor(readonly options: HistoryPollerOptions) {
      FakePoller.instances.push(this)
    }
    static instances: FakePoller[] = []
    start(): void {
      this.started = true
    }
    stop(): void {
      this.stopped = true
    }
    requestRunNow(onStarted: () => void): void {
      this.runNowRequests.push(onStarted)
    }
  }
  return {
    FakePoller,
    runInboxBackfill: vi.fn(),
    reconcileInboxMembership: vi.fn(),
    pendingActionCount: vi.fn(() => 0)
  }
})

// planBackfillStart is a pure cursor router, so the real one runs here — mocking
// it would stop these tests from covering how a cursor picks the starting phase.
vi.mock('./sync/backfill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/backfill')>()),
  runInboxBackfill: mocks.runInboxBackfill
}))
vi.mock('./sync/poller', () => ({
  HistoryPoller: mocks.FakePoller,
  reconcileInboxMembership: mocks.reconcileInboxMembership
}))
vi.mock('./actions', () => ({ pendingActionCount: mocks.pendingActionCount }))

const { SyncController } = await import('./syncController')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the fire-and-forget backfill promise chain settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function harness(options: { backfillCursor?: string | null } = {}) {
  const session = { signedIn: true, seeded: false, accountId: 'user@example.com' as string | null }
  const states: SyncState[] = []
  const backfills: Array<{ callbacks: BackfillCallbacks; result: Deferred<BackfillResult | null> }> = []
  const trigger = vi.fn(async () => {})
  const mirrorTrigger = vi.fn(async () => {})
  const wakeThread = vi.fn()
  const broadcastMailChanged = vi.fn()
  const provider = { id: 'provider' } as unknown as GmailMailProvider

  mocks.runInboxBackfill.mockImplementation((_db, _provider, callbacks: BackfillCallbacks) => {
    const result = deferred<BackfillResult | null>()
    backfills.push({ callbacks, result })
    return result.promise
  })

  const db = {
    prepare: () => ({ get: () => ({ backfill_cursor: options.backfillCursor ?? null }) })
  } as unknown as Db

  const controller = new SyncController({
    db,
    currentAccountId: () => session.accountId,
    isSignedIn: () => session.signedIn,
    isSeeded: () => session.seeded,
    makeProvider: vi.fn(() => provider),
    isForeground: () => false,
    broadcastState: (state) => states.push(state),
    broadcastMailChanged,
    getActionExecutor: () => ({ trigger }) as unknown as ActionExecutor,
    getDraftMirrorExecutor: () => ({ trigger: mirrorTrigger }) as unknown as DraftMirrorExecutor,
    getSnoozeScheduler: () => ({ wakeThread }) as unknown as SnoozeScheduler
  })

  return {
    controller,
    session,
    states,
    backfills,
    trigger,
    mirrorTrigger,
    broadcastMailChanged,
    provider
  }
}

beforeEach(() => {
  mocks.FakePoller.instances = []
  mocks.runInboxBackfill.mockReset()
  mocks.reconcileInboxMembership.mockReset()
  mocks.pendingActionCount.mockReset()
  mocks.pendingActionCount.mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('retry routing', () => {
  it('does no online work while signed out', () => {
    const { controller, session, trigger } = harness()
    session.signedIn = false

    controller.retry()

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
  })

  it('settles a seeded store to idle without touching the network', () => {
    const { controller, session, states } = harness()
    session.seeded = true
    controller.setStateForTest({ phase: 'error', message: 'stale' })
    states.length = 0

    controller.retry()

    expect(states).toEqual([{ phase: 'idle' }])
    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
  })

  it('starts a backfill when nothing is running', () => {
    const { controller, trigger } = harness()

    controller.retry()

    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()
    expect(trigger).toHaveBeenCalledOnce()
  })

  it('pokes the existing poller instead of starting a second backfill', async () => {
    const { controller, backfills } = harness()
    controller.retry()
    backfills[0].result.resolve({ threadCount: 1, inboxThreadIds: ['t1'] })
    await flush()
    const poller = mocks.FakePoller.instances[0]
    expect(poller).toBeDefined()

    controller.retry()

    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()
    expect(poller.runNowRequests.length).toBeGreaterThan(0)
  })

  it('queues a retry while a backfill is running and re-enters when it finishes empty', async () => {
    const { controller, backfills } = harness()
    controller.retry()
    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()

    controller.retry()
    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()

    backfills[0].result.resolve(null)
    await flush()

    expect(mocks.runInboxBackfill).toHaveBeenCalledTimes(2)
  })
})

describe('generation guards', () => {
  it('ignores progress from a backfill belonging to a previous account', async () => {
    const { controller, backfills, states } = harness()
    controller.retry()
    const stale = backfills[0]
    states.length = 0

    controller.onSignOut()
    states.length = 0
    stale.callbacks.onProgress?.({ stage: 'metadata', threadsDone: 12, mailChanged: false })

    expect(states).toEqual([])
  })

  it('does not publish idle or reconcile when a stale backfill resolves after sign-out', async () => {
    const { controller, session, backfills, states, broadcastMailChanged } = harness()
    controller.retry()
    const stale = backfills[0]

    session.signedIn = false
    controller.onSignOut()
    states.length = 0
    broadcastMailChanged.mockClear()
    stale.result.resolve({ threadCount: 3, inboxThreadIds: ['t1'] })
    await flush()

    expect(mocks.reconcileInboxMembership).not.toHaveBeenCalled()
    expect(states).toEqual([])
    expect(broadcastMailChanged).not.toHaveBeenCalled()
    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()
  })

  it('hands a stale backfill off to the new session on an account switch', async () => {
    const { controller, backfills, trigger } = harness()
    controller.retry()
    const stale = backfills[0]

    // The generation moves on, but a session is still active — an account switch,
    // not a sign-out. onSignIn already restarts sync for the new account.
    controller.onSignIn()
    await flush()
    trigger.mockClear()

    stale.result.resolve({ threadCount: 3, inboxThreadIds: ['t1'] })
    await flush()

    // The stale result is discarded rather than reconciled against the new account,
    // and the switch re-drains the queue so mail already queued keeps flowing.
    expect(mocks.reconcileInboxMembership).not.toHaveBeenCalled()
    expect(trigger).toHaveBeenCalledTimes(2)
  })

  it('bumps the generation and clears state on sign-in', () => {
    const { controller } = harness()
    const before = controller.getGeneration()

    controller.onSignIn()

    expect(controller.getGeneration()).toBe(before + 1)
  })
})

describe('backfill to poller handoff', () => {
  it('skips the backfill and starts the poller when the cursor is already done', () => {
    const { controller } = harness({ backfillCursor: 'done' })

    controller.retry()

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    const poller = mocks.FakePoller.instances[0]
    expect(poller.started).toBe(true)
    expect(poller.runNowRequests).toHaveLength(1)
  })

  it('reconciles, publishes idle, and starts the poller after a successful backfill', async () => {
    const { controller, backfills, states, broadcastMailChanged } = harness()
    controller.retry()

    backfills[0].result.resolve({ threadCount: 2, inboxThreadIds: ['t1', 't2'] })
    await flush()

    expect(mocks.reconcileInboxMembership).toHaveBeenCalledWith(expect.anything(), 'user@example.com', [
      't1',
      't2'
    ])
    expect(states.at(-1)).toEqual({ phase: 'idle' })
    expect(broadcastMailChanged).toHaveBeenCalled()
    expect(mocks.FakePoller.instances[0].started).toBe(true)
  })

  it('passes a context-supplied isForeground to the poller rather than reaching for Electron', () => {
    const { controller } = harness({ backfillCursor: 'done' })

    controller.retry()

    expect(mocks.FakePoller.instances[0].options.isForeground()).toBe(false)
  })

  it('wakes the draft mirror after an inbound sweep can make local work pending', () => {
    const { controller, mirrorTrigger } = harness({ backfillCursor: 'done' })
    controller.retry()
    mirrorTrigger.mockClear()

    mocks.FakePoller.instances[0].options.kickExecutor?.()

    expect(mirrorTrigger).toHaveBeenCalledOnce()
  })
})

describe('offline retry', () => {
  it('schedules a retry after an offline failure and restarts sync when it fires', async () => {
    vi.useFakeTimers()
    const { controller, backfills, states } = harness()
    controller.retry()

    backfills[0].callbacks.onError?.(new Error('fetch failed'))
    expect(states.at(-1)).toEqual({ phase: 'offline', message: 'fetch failed' })
    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runInboxBackfill).toHaveBeenCalledTimes(2)
  })

  it('does not schedule an offline retry for a non-network failure', async () => {
    vi.useFakeTimers()
    const { controller, backfills, states } = harness()
    controller.retry()

    backfills[0].callbacks.onError?.(new Error('bad credentials'))
    expect(states.at(-1)).toEqual({ phase: 'error', message: 'bad credentials' })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()
  })

  it('drops a pending offline retry on stop', async () => {
    vi.useFakeTimers()
    const { controller, backfills } = harness()
    controller.retry()
    backfills[0].callbacks.onError?.(new Error('fetch failed'))

    controller.stop()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runInboxBackfill).toHaveBeenCalledOnce()
  })
})

describe('resumeOnlineWork', () => {
  it('drains the executor twice so an account switch picks up the new queue', async () => {
    const { controller, trigger } = harness()

    await controller.resumeOnlineWork()

    expect(trigger).toHaveBeenCalledTimes(2)
  })

  it('drains the queue without starting sync while signed out', async () => {
    const { controller, session, trigger } = harness()
    session.signedIn = false

    await controller.resumeOnlineWork()

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    expect(trigger).toHaveBeenCalledTimes(2)
  })
})

describe('stop', () => {
  it('stops the history poller', async () => {
    const { controller, backfills } = harness()
    controller.retry()
    backfills[0].result.resolve({ threadCount: 1, inboxThreadIds: ['t1'] })
    await flush()

    controller.stop()

    expect(mocks.FakePoller.instances[0].stopped).toBe(true)
  })

  it('makes retry and queued online work inert', async () => {
    const { controller, trigger } = harness()

    controller.stop()
    controller.retry()
    await controller.resumeOnlineWork()

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
  })

  it('invalidates an in-flight backfill before resources are torn down', async () => {
    const { controller, backfills, states, broadcastMailChanged } = harness()
    controller.retry()
    const inFlight = backfills[0]
    states.length = 0
    broadcastMailChanged.mockClear()

    controller.stop()
    inFlight.callbacks.onProgress?.({ stage: 'metadata', threadsDone: 1, mailChanged: true })
    inFlight.result.resolve({ threadCount: 1, inboxThreadIds: ['t1'] })
    await flush()

    expect(states).toEqual([])
    expect(broadcastMailChanged).not.toHaveBeenCalled()
    expect(mocks.reconcileInboxMembership).not.toHaveBeenCalled()
  })
})
