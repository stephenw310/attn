import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncState } from '../shared/mail'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import { GmailApiError } from './gmail/client'
import type { GmailMailProvider } from './gmail/provider'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import type { OutboxSender } from './outbox/sender'
import type { SnoozeScheduler } from './scheduler'
import type {
  AttachmentFlagCallbacks,
  AttachmentFlagOptions,
  AttachmentFlagResult
} from './sync/attachmentFlags'
import type { BackfillCallbacks, BackfillResult } from './sync/backfill'
import type { ThreadExistenceSweepResult } from './sync/existenceSweep'
import type { FtsBackfillCallbacks, FtsBackfillOptions, FtsBackfillResult } from './sync/ftsBackfill'
import type { LifetimeSweepCallbacks, LifetimeSweepOptions, LifetimeSweepResult } from './sync/lifetimeSweep'
import type { HistoryPollerOptions } from './sync/poller'
import type { SplitMetadataCallbacks, SplitMetadataOptions, SplitMetadataResult } from './sync/splitMetadata'

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
    runMailboxMembershipBackfill: vi.fn(),
    runInboxBackfill: vi.fn(),
    runLifetimeSweep: vi.fn(),
    runAttachmentFlagWalk: vi.fn(),
    runSplitMetadataRebuild: vi.fn(),
    runFtsBackfill: vi.fn(),
    reconcileThreadExistence: vi.fn(),
    syncLabelCatalog: vi.fn(),
    reconcileInboxMembership: vi.fn(),
    reconcilePurgeableMembership: vi.fn(async () => {})
  }
})

vi.mock('./db/mailboxMembership', () => ({
  runMailboxMembershipBackfill: mocks.runMailboxMembershipBackfill
}))
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
vi.mock('./sync/existenceSweep', () => ({
  reconcileThreadExistence: mocks.reconcileThreadExistence
}))
vi.mock('./sync/labels', () => ({ syncLabelCatalog: mocks.syncLabelCatalog }))
vi.mock('./sync/attachmentFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/attachmentFlags')>()),
  runAttachmentFlagWalk: mocks.runAttachmentFlagWalk
}))
vi.mock('./sync/splitMetadata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/splitMetadata')>()),
  runSplitMetadataRebuild: mocks.runSplitMetadataRebuild
}))
vi.mock('./sync/ftsBackfill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync/ftsBackfill')>()),
  runFtsBackfill: mocks.runFtsBackfill
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
  const session = {
    signedIn: true,
    seeded: false,
    accountId: 'user@example.com' as string | null,
    backfillCursor: options.backfillCursor ?? null
  }
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
  const attachmentWalks: Array<{
    callbacks: AttachmentFlagCallbacks
    options: AttachmentFlagOptions
    result: Deferred<AttachmentFlagResult | null>
  }> = []
  const splitMetadataRebuilds: Array<{
    callbacks: SplitMetadataCallbacks
    options: SplitMetadataOptions
    result: Deferred<SplitMetadataResult | null>
  }> = []
  const ftsBackfills: Array<{
    accountId: string
    callbacks: FtsBackfillCallbacks
    options: FtsBackfillOptions
    result: Deferred<FtsBackfillResult | null>
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

  mocks.runAttachmentFlagWalk.mockImplementation(
    (_db, _provider, _accountId, callbacks: AttachmentFlagCallbacks, walkOptions: AttachmentFlagOptions) => {
      const result = deferred<AttachmentFlagResult | null>()
      attachmentWalks.push({ callbacks, options: walkOptions, result })
      return result.promise
    }
  )
  mocks.runSplitMetadataRebuild.mockImplementation(
    (_db, _provider, _accountId, callbacks: SplitMetadataCallbacks, rebuildOptions: SplitMetadataOptions) => {
      const result = deferred<SplitMetadataResult | null>()
      splitMetadataRebuilds.push({ callbacks, options: rebuildOptions, result })
      return result.promise
    }
  )
  mocks.runFtsBackfill.mockImplementation(
    (_db, accountId: string, callbacks: FtsBackfillCallbacks, backfillOptions: FtsBackfillOptions) => {
      const result = deferred<FtsBackfillResult | null>()
      ftsBackfills.push({ accountId, callbacks, options: backfillOptions, result })
      return result.promise
    }
  )

  const db = {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes('SELECT backfill_cursor') ? { backfill_cursor: session.backfillCursor } : undefined,
      // The T35 recovery guard reads/writes a settings row and lists live
      // follow-ups around the backfill; none exist in this harness.
      all: () => [],
      run: () => ({ changes: 0 })
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
    mailRevision: () => 0,
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
    getSnoozeScheduler: () => ({ wakeThread, refresh: () => {} }) as unknown as SnoozeScheduler
  })

  return {
    controller,
    session,
    foregroundWork,
    states,
    backfills,
    lifetimeSweeps,
    attachmentWalks,
    splitMetadataRebuilds,
    ftsBackfills,
    trigger,
    mirrorTrigger,
    outboxTrigger,
    broadcastMailChanged,
    db,
    provider
  }
}

beforeEach(() => {
  mocks.FakePoller.instances = []
  mocks.runMailboxMembershipBackfill.mockReset()
  mocks.runMailboxMembershipBackfill.mockResolvedValue({ threadsIndexed: 0, complete: true })
  mocks.runInboxBackfill.mockReset()
  mocks.runLifetimeSweep.mockReset()
  mocks.runAttachmentFlagWalk.mockReset()
  mocks.runSplitMetadataRebuild.mockReset()
  mocks.runFtsBackfill.mockReset()
  mocks.reconcileThreadExistence.mockReset()
  mocks.reconcileThreadExistence.mockResolvedValue({ listedThreadCount: 0, deletedThreadIds: [] })
  mocks.syncLabelCatalog.mockReset()
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
    const { controller, session, backfills } = harness()
    controller.retry()
    backfills[0].result.resolve({
      threadCount: 1,
      inboxThreadIds: ['t1'],
      spamThreadIds: [],
      trashThreadIds: []
    })
    session.backfillCursor = 'done'
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

  it('starts the poller at interactive-ready, once, and keeps its cycles silent mid-backfill', async () => {
    const { controller, session, backfills, states, broadcastMailChanged } = harness()
    controller.retry()
    expect(mocks.FakePoller.instances).toHaveLength(0)

    // Inbox metadata still streaming: not interactive-ready yet.
    backfills[0].callbacks.onProgress({ stage: 'metadata', threadsDone: 40, mailChanged: true })
    expect(mocks.FakePoller.instances).toHaveLength(0)

    // Leaving the metadata stage is the interactive-ready signal.
    backfills[0].callbacks.onProgress({ stage: 'bodies', threadsDone: 40, mailChanged: false })
    const poller = mocks.FakePoller.instances[0]
    expect(poller).toBeDefined()
    expect(poller.started).toBe(true)

    // A poll cycle completing mid-backfill broadcasts mail but never
    // publishes a settled state over the syncing progress display.
    broadcastMailChanged.mockClear()
    states.length = 0
    poller.options.onCycleStart?.()
    poller.options.onCycleComplete(true)
    expect(broadcastMailChanged).toHaveBeenCalledOnce()
    expect(states).toEqual([])

    // Later stages and completion reuse the same poller instance.
    backfills[0].callbacks.onProgress({ stage: 'all-mail', threadsDone: 90, mailChanged: true })
    backfills[0].result.resolve({
      threadCount: 90,
      inboxThreadIds: ['t1'],
      spamThreadIds: [],
      trashThreadIds: []
    })
    session.backfillCursor = 'done'
    await flush()
    expect(mocks.FakePoller.instances).toHaveLength(1)
    expect(states.at(-1)).toEqual({ phase: 'idle' })
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
    const {
      controller,
      lifetimeSweeps,
      attachmentWalks,
      splitMetadataRebuilds,
      states,
      broadcastMailChanged
    } = harness({ backfillCursor: 'done' })
    controller.retry()
    const sweep = lifetimeSweeps[0]

    sweep.callbacks.onProgress({
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running'
    })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: 500,
      threadsTotal: 2_000,
      messagesTotal: 3_000,
      reason: 'running'
    })
    expect(broadcastMailChanged).not.toHaveBeenCalled()

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
      waitMs: 250
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

    // Indexing is not over when the header sweep ends: the ids-only attachment
    // tail follows it, and only its completion settles the footer.
    sweep.result.resolve({ threadCount: 2_000, elapsedMs: 60_000, quotaWaitMs: 500 })
    await flush()
    expect(states.at(-1)).not.toEqual({ phase: 'idle' })
    attachmentWalks[0].result.resolve({ threadsFlagged: 0 })
    await flush()
    expect(states.at(-1)).not.toEqual({ phase: 'idle' })
    splitMetadataRebuilds[0].result.resolve({ threadsRefreshed: 0 })
    await flush()
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('runs the derived metadata passes after the sweep under the same pacing', async () => {
    const {
      controller,
      lifetimeSweeps,
      attachmentWalks,
      splitMetadataRebuilds,
      states,
      broadcastMailChanged
    } = harness({ backfillCursor: 'done' })
    controller.onSignIn()
    expect(attachmentWalks).toHaveLength(0)

    lifetimeSweeps[0].result.resolve({ threadCount: 12, elapsedMs: 1_000, quotaWaitMs: 0 })
    await flush()

    expect(attachmentWalks).toHaveLength(1)
    // One posture for both passes: the sweep's cancellation and yield rules.
    expect(attachmentWalks[0].options.shouldYield).toBe(lifetimeSweeps[0].options.shouldYield)

    attachmentWalks[0].callbacks.onProgress({ threadsFlagged: 3, reason: 'running', mailChanged: true })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'attachments',
      threadsDone: 3,
      reason: 'running'
    })
    // Raising the flag has to repaint the chips already on screen.
    expect(broadcastMailChanged).toHaveBeenCalled()

    attachmentWalks[0].result.resolve({ threadsFlagged: 3 })
    await flush()
    expect(splitMetadataRebuilds).toHaveLength(1)
    expect(splitMetadataRebuilds[0].options.shouldYield).toBe(lifetimeSweeps[0].options.shouldYield)
    splitMetadataRebuilds[0].callbacks.onProgress({
      threadsDone: 4,
      reason: 'running',
      mailChanged: true
    })
    expect(states.at(-1)).toEqual({
      phase: 'indexing',
      stage: 'split-metadata',
      threadsDone: 4,
      reason: 'running'
    })
    expect(broadcastMailChanged).toHaveBeenLastCalledWith('split-metadata')
    splitMetadataRebuilds[0].result.resolve({ threadsRefreshed: 4 })
    await flush()
    expect(states.at(-1)).toEqual({ phase: 'idle' })
  })

  it('starts the new account FTS pass after a stale account pass exits', async () => {
    const { controller, session, lifetimeSweeps, attachmentWalks, splitMetadataRebuilds, ftsBackfills } =
      harness({ backfillCursor: 'done' })
    controller.onSignIn()
    lifetimeSweeps[0].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await flush()
    attachmentWalks[0].result.resolve({ threadsFlagged: 0 })
    await flush()
    splitMetadataRebuilds[0].result.resolve({ threadsRefreshed: 0 })
    await flush()
    expect(ftsBackfills.map((run) => run.accountId)).toEqual(['user@example.com'])

    session.accountId = 'next@example.com'
    controller.onSignIn()
    lifetimeSweeps[1].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await flush()
    attachmentWalks[1].result.resolve({ threadsFlagged: 0 })
    await flush()
    splitMetadataRebuilds[1].result.resolve({ threadsRefreshed: 0 })
    await flush()

    expect(ftsBackfills).toHaveLength(1)
    expect(ftsBackfills[0].options.shouldContinue?.()).toBe(false)
    ftsBackfills[0].result.resolve(null)
    await flush()

    expect(ftsBackfills.map((run) => run.accountId)).toEqual(['user@example.com', 'next@example.com'])
  })

  it('does not start the attachment index when the sweep did not finish', async () => {
    const { controller, lifetimeSweeps, attachmentWalks } = harness({ backfillCursor: 'done' })
    controller.onSignIn()

    lifetimeSweeps[0].result.resolve(null)
    await flush()

    expect(attachmentWalks).toHaveLength(0)
  })

  it('keeps a paused attachment index reporting its own stage', async () => {
    const { controller, lifetimeSweeps, attachmentWalks, states } = harness({ backfillCursor: 'done' })
    controller.onSignIn()
    lifetimeSweeps[0].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await flush()

    attachmentWalks[0].callbacks.onProgress({ threadsFlagged: 1, reason: 'running', mailChanged: false })
    attachmentWalks[0].callbacks.onError(new GmailApiError(429, 'quota', true))

    expect(states.at(-1)).toMatchObject({
      phase: 'indexing',
      stage: 'attachments',
      reason: 'retry-wait',
      threadsDone: 1
    })
  })

  it('keeps a paused split metadata rebuild reporting its own stage', async () => {
    const { controller, lifetimeSweeps, attachmentWalks, splitMetadataRebuilds, states } = harness({
      backfillCursor: 'done'
    })
    controller.onSignIn()
    lifetimeSweeps[0].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await flush()
    attachmentWalks[0].result.resolve({ threadsFlagged: 0 })
    await flush()

    splitMetadataRebuilds[0].callbacks.onProgress({
      threadsDone: 2,
      reason: 'running',
      mailChanged: false
    })
    splitMetadataRebuilds[0].callbacks.onError(new GmailApiError(429, 'quota', true))

    expect(states.at(-1)).toMatchObject({
      phase: 'indexing',
      stage: 'split-metadata',
      reason: 'retry-wait',
      threadsDone: 2
    })
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

  it('finishes expiry tombstoning before replacing the checkpoint with a recovery backfill', async () => {
    const { controller, backfills, lifetimeSweeps, states, broadcastMailChanged, db, provider } = harness({
      backfillCursor: 'done'
    })
    const existence = deferred<ThreadExistenceSweepResult | null>()
    mocks.reconcileThreadExistence.mockReturnValueOnce(existence.promise)
    controller.retry()
    const poller = mocks.FakePoller.instances[0]
    const lifetime = lifetimeSweeps[0]

    const recovery = poller.options.recoverExpiredHistory()
    expect(lifetime.options.shouldYield?.()).toBe(true)
    expect(states.at(-1)).toEqual({ phase: 'syncing', stage: 'metadata', threadsDone: 0 })
    expect(mocks.reconcileThreadExistence).toHaveBeenCalledWith(
      db,
      'user@example.com',
      provider,
      expect.objectContaining({ shouldContinue: expect.any(Function) })
    )
    expect(mocks.runInboxBackfill).not.toHaveBeenCalled()

    existence.resolve({ listedThreadCount: 9, deletedThreadIds: ['purged'] })
    await flush()
    expect(broadcastMailChanged).toHaveBeenCalledOnce()
    expect(mocks.runInboxBackfill).toHaveBeenCalledWith(db, provider, expect.anything(), { recovery: true })
    expect(lifetime.options.shouldYield?.()).toBe(true)

    backfills[0].result.resolve({
      threadCount: 9,
      inboxThreadIds: ['inbox'],
      spamThreadIds: ['spam'],
      trashThreadIds: ['trash']
    })
    await recovery
    expect(lifetime.options.shouldYield?.()).toBe(false)
    expect(mocks.runLifetimeSweep).toHaveBeenCalledOnce()
  })

  it('keeps Inbox readiness blocked after recovery fails and clears it after retry', async () => {
    const { controller, backfills } = harness({ backfillCursor: 'done' })
    mocks.reconcileThreadExistence.mockRejectedValueOnce(new Error('offline'))
    controller.retry()
    const poller = mocks.FakePoller.instances[0]

    await expect(poller.options.recoverExpiredHistory()).rejects.toThrow('offline')
    expect(controller.isInboxRecoveryPending()).toBe(true)

    const retry = poller.options.recoverExpiredHistory()
    await flush()
    backfills[0].result.resolve({
      threadCount: 0,
      inboxThreadIds: [],
      spamThreadIds: [],
      trashThreadIds: []
    })
    await retry

    expect(controller.isInboxRecoveryPending()).toBe(false)
  })

  it('clears failed recovery readiness after an ordinary backfill resumes its cursor', async () => {
    const { controller, session, backfills } = harness({ backfillCursor: 'done' })
    mocks.reconcileThreadExistence.mockRejectedValueOnce(new Error('offline'))
    controller.retry()
    const poller = mocks.FakePoller.instances[0]

    await expect(poller.options.recoverExpiredHistory()).rejects.toThrow('offline')
    expect(controller.isInboxRecoveryPending()).toBe(true)

    session.backfillCursor = 'metadata:page-2'
    controller.retry()
    expect(backfills).toHaveLength(1)
    backfills[0].result.resolve({
      threadCount: 0,
      inboxThreadIds: [],
      spamThreadIds: [],
      trashThreadIds: []
    })
    session.backfillCursor = 'done'
    await flush()

    expect(controller.isInboxRecoveryPending()).toBe(false)
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
      reason: 'running'
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

    sweep.callbacks.onProgress({ threadsDone: 700, reason: 'running' })
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

  it('gives each poll cycle an authoritative label-catalog refresh', async () => {
    const { controller, db, provider } = harness({ backfillCursor: 'done' })
    mocks.syncLabelCatalog.mockResolvedValue(true)
    controller.retry()

    await expect(mocks.FakePoller.instances[0].options.syncLabels?.()).resolves.toBe(true)

    expect(mocks.syncLabelCatalog).toHaveBeenCalledWith(db, 'user@example.com', provider)
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

  it('retries a failed FTS pass without replaying the completed Gmail indexers', async () => {
    vi.useFakeTimers()
    const { controller, lifetimeSweeps, attachmentWalks, splitMetadataRebuilds, ftsBackfills } = harness({
      backfillCursor: 'done'
    })
    controller.retry()
    lifetimeSweeps[0].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    attachmentWalks[0].result.resolve({ threadsFlagged: 0 })
    await vi.advanceTimersByTimeAsync(0)
    splitMetadataRebuilds[0].result.resolve({ threadsRefreshed: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ftsBackfills).toHaveLength(1)

    ftsBackfills[0].callbacks.onError(new Error('database is full'))
    ftsBackfills[0].result.resolve(null)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(15_000)

    expect(ftsBackfills).toHaveLength(2)
    expect(mocks.runLifetimeSweep).toHaveBeenCalledOnce()
    expect(mocks.runAttachmentFlagWalk).toHaveBeenCalledOnce()
    expect(mocks.runSplitMetadataRebuild).toHaveBeenCalledOnce()
  })

  it('does not retry an FTS pass canceled without an error', async () => {
    vi.useFakeTimers()
    const { controller, lifetimeSweeps, attachmentWalks, splitMetadataRebuilds, ftsBackfills } = harness({
      backfillCursor: 'done'
    })
    controller.retry()
    lifetimeSweeps[0].result.resolve({ threadCount: 0, elapsedMs: 0, quotaWaitMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    attachmentWalks[0].result.resolve({ threadsFlagged: 0 })
    await vi.advanceTimersByTimeAsync(0)
    splitMetadataRebuilds[0].result.resolve({ threadsRefreshed: 0 })
    await vi.advanceTimersByTimeAsync(0)

    ftsBackfills[0].result.resolve(null)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(ftsBackfills).toHaveLength(1)
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
    retried.callbacks.onProgress({ threadsDone: 900, reason: 'running' })
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
