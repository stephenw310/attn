import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncState } from '../shared/mail'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import { GmailApiError } from './gmail/client'
import type { GmailMailProvider } from './gmail/provider'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import type { OutboxSender } from './outbox/sender'
import type { SnoozeScheduler } from './scheduler'
import type { BackfillCallbacks, BackfillResult } from './sync/backfill'
import type { LifetimeSweepCallbacks, LifetimeSweepOptions, LifetimeSweepResult } from './sync/lifetimeSweep'
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
    runLifetimeSweep: vi.fn(),
    reconcileInboxMembership: vi.fn(),
    reconcilePurgeableMembership: vi.fn(async () => {})
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
  reconcileInboxMembership: mocks.reconcileInboxMembership,
  reconcilePurgeableMembership: mocks.reconcilePurgeableMembership
}))
vi.mock('./sync/lifetimeSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/lifetimeSweep')>()),
  runLifetimeSweep: mocks.runLifetimeSweep
}))
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
  const foregroundWork = {
    actionActive: false,
    draftActive: false,
    outboxActive: false,
    providerActive: false
  }
  const states: SyncState[] = []
  const backfills: Array<{ callbacks: BackfillCallbacks; result: Deferred<BackfillResult | null> }> = []
  const lifetimeSweeps: Array<{
    callbacks: LifetimeSweepCallbacks
    options: LifetimeSweepOptions
    result: Deferred<LifetimeSweepResult | null>
  }> = []
  const trigger = vi.fn(async () => {})
  const mirrorTrigger = vi.fn(async () => {})
  const outboxTrigger = vi.fn(async () => {})
  const wakeThread = vi.fn()
  const broadcastMailChanged = vi.fn()
  const provider = { id: 'provider' } as unknown as GmailMailProvider

  mocks.runInboxBackfill.mockImplementation((_db, _provider, callbacks: BackfillCallbacks) => {
    const result = deferred<BackfillResult | null>()
    backfills.push({ callbacks, result })
    return result.promise
  })
  mocks.runLifetimeSweep.mockImplementation(
    (_db, _provider, _accountId, callbacks: LifetimeSweepCallbacks, sweepOptions: LifetimeSweepOptions) => {
      const result = deferred<LifetimeSweepResult | null>()
      lifetimeSweeps.push({ callbacks, options: sweepOptions, result })
      return result.promise
    }
  )

  const db = {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes('SELECT backfill_cursor')
          ? { backfill_cursor: options.backfillCursor ?? null }
          : undefined
    })
  } as unknown as Db

  const controller = new SyncController({
    db,
    currentAccountId: () => session.accountId,
    isSignedIn: () => session.signedIn,
    isSeeded: () => session.seeded,
    makeProvider: vi.fn(() => provider),
    isForeground: () => false,
    hasForegroundProviderWork: () => foregroundWork.providerActive,
    broadcastState: (state) => states.push(state),
    broadcastMailChanged,
    getActionExecutor: () =>
      ({ trigger, isRunning: () => foregroundWork.actionActive }) as unknown as ActionExecutor,
    getDraftMirrorExecutor: () =>
      ({
        trigger: mirrorTrigger,
        isRunning: () => foregroundWork.draftActive
      }) as unknown as DraftMirrorExecutor,
    getOutboxSender: () =>
      ({ trigger: outboxTrigger, isRunning: () => foregroundWork.outboxActive }) as unknown as OutboxSender,
    getSnoozeScheduler: () => ({ wakeThread }) as unknown as SnoozeScheduler
  })

  return {
    controller,
    session,
    foregroundWork,
    states,
    backfills,
    lifetimeSweeps,
    trigger,
    mirrorTrigger,
    outboxTrigger,
    broadcastMailChanged,
    provider
  }
}

beforeEach(() => {
  mocks.FakePoller.instances = []
  mocks.runInboxBackfill.mockReset()
  mocks.runLifetimeSweep.mockReset()
  mocks.reconcileInboxMembership.mockReset()
  mocks.reconcilePurgeableMembership.mockReset()
  mocks.reconcilePurgeableMembership.mockImplementation(async () => {})
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
    backfills[0].result.resolve({
      threadCount: 1,
      inboxThreadIds: ['t1'],
      spamThreadIds: [],
      trashThreadIds: []
    })
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
    stale.result.resolve({ threadCount: 3, inboxThreadIds: ['t1'], spamThreadIds: [], trashThreadIds: [] })
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

    stale.result.resolve({ threadCount: 3, inboxThreadIds: ['t1'], spamThreadIds: [], trashThreadIds: [] })
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
  it('skips the backfill and starts the poller plus lifetime sweep when the cursor is done', () => {
    const { controller, lifetimeSweeps } = harness({ backfillCursor: 'done' })

    controller.retry()

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    const poller = mocks.FakePoller.instances[0]
    expect(poller.started).toBe(true)
    expect(poller.runNowRequests).toHaveLength(1)
    expect(lifetimeSweeps).toHaveLength(1)
    expect(mocks.runLifetimeSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user@example.com',
      expect.anything(),
      expect.anything()
    )
  })

  it('reconciles, publishes idle, and starts the poller after a successful backfill', async () => {
    const { controller, backfills, lifetimeSweeps, states, broadcastMailChanged } = harness()
    controller.retry()

    backfills[0].result.resolve({
      threadCount: 2,
      inboxThreadIds: ['t1', 't2'],
      spamThreadIds: ['s1'],
      trashThreadIds: ['x1']
    })
    await flush()

    expect(mocks.reconcileInboxMembership).toHaveBeenCalledWith(expect.anything(), 'user@example.com', [
      't1',
      't2'
    ])
    expect(mocks.reconcilePurgeableMembership).toHaveBeenCalledWith(
      expect.anything(),
      'user@example.com',
      expect.anything(),
      'SPAM',
      ['s1']
    )
    expect(mocks.reconcilePurgeableMembership).toHaveBeenCalledWith(
      expect.anything(),
      'user@example.com',
      expect.anything(),
      'TRASH',
      ['x1']
    )
    expect(states.at(-1)).toEqual({ phase: 'idle' })
    expect(broadcastMailChanged).toHaveBeenCalled()
    expect(mocks.FakePoller.instances[0].started).toBe(true)
    expect(lifetimeSweeps).toHaveLength(1)
  })

  it('publishes lifetime progress as live indexing and restores it after a history cycle', async () => {
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()
    const sweep = lifetimeSweeps[0]

    sweep.callbacks.onProgress({
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running',
      mailChanged: false
    })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running'
    })

    const poller = mocks.FakePoller.instances[0]
    poller.options.onCycleStart?.()
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running'
    })
    sweep.callbacks.onProgress({
      threadsDone: 600,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'foreground-yield',
      waitMs: 250,
      mailChanged: false
    })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running'
    })

    poller.options.onCycleComplete(false)
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 600,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'foreground-yield',
      waitMs: 250
    })

    sweep.result.resolve({ threadCount: 2_000 })
    await flush()
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('makes the sweep yield while mail actions, sends, hydration, or history polling have priority', () => {
    const { controller, foregroundWork, lifetimeSweeps } = harness({ backfillCursor: 'done' })
    controller.retry()
    const shouldYield = lifetimeSweeps[0].options.shouldYield
    expect(shouldYield?.()).toBe(false)

    foregroundWork.actionActive = true
    expect(shouldYield?.()).toBe(true)
    foregroundWork.actionActive = false

    foregroundWork.draftActive = true
    expect(shouldYield?.()).toBe(true)
    foregroundWork.draftActive = false

    foregroundWork.outboxActive = true
    expect(shouldYield?.()).toBe(true)
    foregroundWork.outboxActive = false

    foregroundWork.providerActive = true
    expect(shouldYield?.()).toBe(true)
    foregroundWork.providerActive = false

    mocks.FakePoller.instances[0].options.onCycleStart?.()
    expect(shouldYield?.()).toBe(true)
  })

  it('does not let background progress overwrite a history failure', () => {
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()
    const sweep = lifetimeSweeps[0]
    const poller = mocks.FakePoller.instances[0]

    poller.options.onCycleStart?.()
    poller.options.onError(new Error('history offline'))
    expect(states.at(-1)).toEqual({ phase: 'offline', message: 'history offline' })

    sweep.callbacks.onProgress({
      threadsDone: 700,
      threadsTotal: 2_000,
      reason: 'running',
      mailChanged: false
    })
    expect(states.at(-1)).toEqual({ phase: 'offline', message: 'history offline' })

    poller.options.onCycleStart?.()
    poller.options.onCycleComplete(false)
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 700,
      threadsTotal: 2_000,
      reason: 'running'
    })
  })

  it('keeps a failed lifetime sweep non-blocking while it waits to retry', () => {
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()
    const sweep = lifetimeSweeps[0]
    const poller = mocks.FakePoller.instances[0]

    sweep.callbacks.onProgress({ threadsDone: 700, reason: 'running', mailChanged: false })
    sweep.callbacks.onError(new Error('lifetime offline'))
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 700,
      reason: 'retry-wait',
      waitMs: 15_000,
      message: 'lifetime offline'
    })

    poller.options.onCycleStart?.()
    poller.options.onCycleComplete(false)
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 700,
      reason: 'retry-wait',
      waitMs: 15_000,
      message: 'lifetime offline'
    })
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

  it('resumes a failed lifetime cursor without restarting the completed backfill', async () => {
    vi.useFakeTimers()
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()

    lifetimeSweeps[0].callbacks.onError(new Error('offline'))
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 0,
      reason: 'retry-wait',
      waitMs: 15_000,
      message: 'offline'
    })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()
    expect(mocks.runLifetimeSweep).toHaveBeenCalledTimes(2)
  })

  it('retries a Gmail rate-limit failure without putting the app offline', async () => {
    vi.useFakeTimers()
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()

    lifetimeSweeps[0].callbacks.onError(new GmailApiError(429, 'rate limited', true))
    expect(states.at(-1)).toMatchObject({ phase: 'indexing', reason: 'retry-wait' })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runLifetimeSweep).toHaveBeenCalledTimes(2)
  })

  it('pauses a non-retryable lifetime failure without masking foreground sync health', async () => {
    vi.useFakeTimers()
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()

    lifetimeSweeps[0].callbacks.onError(new GmailApiError(401, 'invalid credentials'))
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 0,
      reason: 'paused',
      message: 'invalid credentials'
    })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.runLifetimeSweep).toHaveBeenCalledOnce()
  })

  it('invalidates the failed lifetime run before a same-session retry starts', async () => {
    const { controller, lifetimeSweeps, states } = harness({ backfillCursor: 'done' })
    controller.retry()
    const failed = lifetimeSweeps[0]
    failed.callbacks.onError(new Error('offline'))

    controller.retry()
    const retried = lifetimeSweeps[1]
    expect(failed.options.shouldContinue?.()).toBe(false)
    expect(retried.options.shouldContinue?.()).toBe(true)

    failed.result.resolve(null)
    await flush()
    retried.callbacks.onProgress({ threadsDone: 900, reason: 'running', mailChanged: false })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 900,
      reason: 'running'
    })
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
    backfills[0].result.resolve({
      threadCount: 1,
      inboxThreadIds: ['t1'],
      spamThreadIds: [],
      trashThreadIds: []
    })
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
    inFlight.result.resolve({ threadCount: 1, inboxThreadIds: ['t1'], spamThreadIds: [], trashThreadIds: [] })
    await flush()

    expect(states).toEqual([])
    expect(broadcastMailChanged).not.toHaveBeenCalled()
    expect(mocks.reconcileInboxMembership).not.toHaveBeenCalled()
  })
})
