import type { SyncState } from '../shared/mail'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import { GmailApiError } from './gmail/client'
import type { GmailMailProvider } from './gmail/provider'
import { syncRemoteDrafts } from './outbox/draftSync'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import type { OutboxSender } from './outbox/sender'
import type { SnoozeScheduler } from './scheduler'
import { planBackfillStart, runInboxBackfill } from './sync/backfill'
import { errorMessage, isOfflineFailure, syncFailureState } from './sync/failure'
import { type LifetimeSweepProgress, runLifetimeSweep } from './sync/lifetimeSweep'
import { HistoryPoller, reconcileInboxMembership, reconcilePurgeableMembership } from './sync/poller'
import { OfflineRetryScheduler, syncRetryRoute } from './sync/retry'
import { sameSyncState } from './sync/state'

const LIFETIME_RETRY_MS = 15_000

interface SyncControllerContext {
  db: Db
  currentAccountId: () => string | null
  isSignedIn: () => boolean
  isSeeded: () => boolean
  makeProvider: (generation: number) => GmailMailProvider | null
  /** Drives the poller's foreground/background cadence; owned by index.ts so this stays Electron-free. */
  isForeground: () => boolean
  /** True while an interactive body or attachment request is using Gmail for this account. */
  hasForegroundProviderWork: (accountId: string) => boolean
  broadcastState: (state: SyncState) => void
  broadcastMailChanged: () => void
  getActionExecutor: () => ActionExecutor | null
  getDraftMirrorExecutor: () => DraftMirrorExecutor | null
  getOutboxSender: () => OutboxSender | null
  getSnoozeScheduler: () => SnoozeScheduler | null
}

/**
 * Owns all online sync lifecycle state. Every async callback captures the
 * current authentication generation; callbacks from an earlier account may
 * cache data locally, but can never publish state or continue that session.
 */
export class SyncController {
  private state: SyncState = { phase: 'idle' }
  private running = false
  private lifetimeRunning = false
  private lifetimeProgress: Extract<SyncState, { phase: 'indexing' }> | null = null
  private foregroundFailure: Extract<SyncState, { phase: 'offline' | 'error' }> | null = null
  private pollerRunning = false
  private stopped = false
  private backfillRetryGeneration: number | null = null
  private generation = 0
  private lifetimeRunId = 0
  private poller: HistoryPoller | null = null
  private readonly offlineRetry = new OfflineRetryScheduler(15_000)
  private readonly lifetimeRetry = new OfflineRetryScheduler(LIFETIME_RETRY_MS)

  constructor(private readonly context: SyncControllerContext) {}

  getState(): SyncState {
    return this.state
  }

  getGeneration(): number {
    return this.generation
  }

  /** E2E-only seam for exercising renderer state transitions through real IPC. */
  setStateForTest(state: SyncState): void {
    if (this.stopped) return
    this.setState(state)
  }

  onSignIn(): void {
    if (this.stopped) return
    this.resetSession()
    void this.resumeOnlineWork()
  }

  onSignOut(): void {
    if (this.stopped) return
    this.resetSession()
    this.setState({ phase: 'idle' })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.resetSession()
  }

  retry(): void {
    if (this.stopped) return
    this.offlineRetry.clear()
    this.lifetimeRetry.clear()
    const route = syncRetryRoute({
      signedIn: this.context.isSignedIn(),
      seeded: this.context.isSeeded(),
      hasPoller: this.poller !== null,
      backfillRunning: this.running
    })
    if (route === 'none') return
    if (route === 'seed') {
      this.setState({ phase: 'idle' })
      return
    }
    if (route === 'poller') {
      this.poller?.requestRunNow(() => this.publishChecking())
      // A poller can outlive a failed backfill now — startSync resumes an
      // unfinished cursor, or falls through to the lifetime sweep when done.
      this.startSync()
    } else if (route === 'queue-backfill') {
      this.backfillRetryGeneration = this.generation
    } else {
      this.startSync()
    }
    void this.context.getActionExecutor()?.trigger()
    void this.context.getDraftMirrorExecutor()?.trigger()
    void this.context.getOutboxSender()?.trigger()
  }

  async resumeOnlineWork(): Promise<void> {
    if (this.stopped) return
    // Remote changes must keep flowing even when a queued local action is in
    // Gmail's retry/backoff loop. The executor and history poller are independent.
    if (this.context.isSignedIn()) this.startSync()
    await Promise.all([
      this.context.getActionExecutor()?.trigger(),
      this.context.getDraftMirrorExecutor()?.trigger(),
      this.context.getOutboxSender()?.trigger()
    ])
    if (this.stopped) return
    // A sign-out/account switch can make an active drain finish early. A second
    // pass picks up the newly active account.
    await Promise.all([
      this.context.getActionExecutor()?.trigger(),
      this.context.getDraftMirrorExecutor()?.trigger(),
      this.context.getOutboxSender()?.trigger()
    ])
  }

  private resetSession(): void {
    this.stopHistoryPoller()
    this.offlineRetry.clear()
    this.lifetimeRetry.clear()
    this.backfillRetryGeneration = null
    this.running = false
    this.lifetimeRunning = false
    this.lifetimeProgress = null
    this.foregroundFailure = null
    this.lifetimeRunId++
    this.generation++
  }

  private setState(state: SyncState): void {
    if (this.stopped) return
    if (sameSyncState(this.state, state)) return
    this.state = state
    this.context.broadcastState(state)
  }

  private failureState(error: unknown, prefix: string): Extract<SyncState, { phase: 'offline' | 'error' }> {
    const next = syncFailureState(error)
    console.error(`${prefix}: ${next.message}`)
    return next
  }

  private publishForegroundFailure(
    error: unknown,
    prefix: string
  ): Extract<SyncState, { phase: 'offline' | 'error' }> {
    const next = this.failureState(error, prefix)
    this.foregroundFailure = next
    this.setState(next)
    return next
  }

  private publishLifetimePause(error: unknown, prefix: string): boolean {
    const message = errorMessage(error)
    const retryable = isOfflineFailure(error) || (error instanceof GmailApiError && error.retryable)
    console.error(`${prefix}: ${message}`)
    const previous = this.lifetimeProgress
    this.lifetimeProgress = {
      phase: 'indexing',
      stage: 'lifetime',
      threadsDone: previous?.threadsDone ?? 0,
      ...(previous?.threadsTotal === undefined ? {} : { threadsTotal: previous.threadsTotal }),
      ...(previous?.messagesTotal === undefined ? {} : { messagesTotal: previous.messagesTotal }),
      ...(previous?.etaMs === undefined ? {} : { etaMs: previous.etaMs }),
      reason: retryable ? 'retry-wait' : 'paused',
      ...(retryable ? { waitMs: LIFETIME_RETRY_MS } : {}),
      message
    }
    if (!this.foregroundFailure && !this.running && !this.pollerRunning) {
      this.setState(this.lifetimeProgress)
    }
    return retryable
  }

  private scheduleOfflineRetry(generation: number): void {
    this.offlineRetry.schedule(
      () => !this.stopped && generation === this.generation && this.context.isSignedIn(),
      () => this.startSync()
    )
  }

  private scheduleLifetimeRetry(accountId: string, provider: GmailMailProvider, generation: number): void {
    this.lifetimeRetry.schedule(
      () =>
        !this.stopped &&
        generation === this.generation &&
        this.context.isSignedIn() &&
        this.context.currentAccountId() === accountId,
      () => this.startLifetimeSweep(accountId, provider, generation)
    )
  }

  private startSync(): void {
    // An alive poller no longer implies the backfill finished (it starts at
    // interactive-ready), so always route through the cursor plan below;
    // startHistoryPoller no-ops when the poller already exists.
    if (this.stopped || this.running || this.context.isSeeded()) return
    this.offlineRetry.clear()
    const generation = this.generation
    const accountId = this.context.currentAccountId()
    const provider = this.context.makeProvider(generation)
    if (!accountId) return
    if (!provider) {
      const message = 'OAuth configuration unavailable — add oauth.config.json'
      this.foregroundFailure = { phase: 'error', message }
      this.setState(this.foregroundFailure)
      console.error(`[sync] failed: ${message}`)
      return
    }
    this.foregroundFailure = null
    const state = this.context.db
      .prepare('SELECT backfill_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null } | undefined
    const backfillPlan = planBackfillStart(state?.backfill_cursor)
    if (backfillPlan.kind === 'skip') {
      this.startHistoryPoller(accountId, provider, generation, true)
      this.startLifetimeSweep(accountId, provider, generation)
      return
    }
    if (this.backfillRetryGeneration === generation) this.backfillRetryGeneration = null
    this.running = true
    this.setState({ phase: 'syncing', stage: backfillPlan.cursor.phase, threadsDone: 0 })
    console.log('[sync] mail backfill started')
    void runInboxBackfill(this.context.db, provider, {
      onProgress: (progress) => {
        if (generation !== this.generation) return
        const { mailChanged, ...stateProgress } = progress
        this.setState({ phase: 'syncing', ...stateProgress })
        if (mailChanged) this.context.broadcastMailChanged()
        // Interactive-ready: the Inbox list is complete once the metadata
        // stage ends, so start polling here instead of after the whole
        // backfill — new mail must not wait out the archive stages. History
        // replays from the pre-backfill checkpoint, so the early start is
        // safe, and cycle completions stay silent while `running` holds.
        if (progress.stage !== 'metadata') {
          this.startHistoryPoller(accountId, provider, generation)
        }
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.running = false
        const failure = this.publishForegroundFailure(error, '[sync] failed')
        if (this.backfillRetryGeneration !== generation && failure.phase === 'offline') {
          this.scheduleOfflineRetry(generation)
        }
      }
    })
      .then(async (result) => {
        if (generation === this.generation) this.running = false
        if (generation !== this.generation) {
          if (this.context.isSignedIn()) void this.resumeOnlineWork()
          return
        }
        if (!result) {
          if (this.backfillRetryGeneration === generation) {
            this.backfillRetryGeneration = null
            this.startSync()
          }
          return
        }
        const retryRequested = this.backfillRetryGeneration === generation
        if (retryRequested) this.backfillRetryGeneration = null
        reconcileInboxMembership(this.context.db, accountId, result.inboxThreadIds)
        await reconcilePurgeableMembership(this.context.db, accountId, provider, 'SPAM', result.spamThreadIds)
        await reconcilePurgeableMembership(
          this.context.db,
          accountId,
          provider,
          'TRASH',
          result.trashThreadIds
        )
        if (generation !== this.generation) {
          if (this.context.isSignedIn()) void this.resumeOnlineWork()
          return
        }
        this.foregroundFailure = null
        this.setState({ phase: 'idle' })
        this.context.broadcastMailChanged()
        console.log(`[sync] backfill done: ${result.threadCount} threads for ${accountId}`)
        const pollerExisted = this.poller !== null
        this.startHistoryPoller(accountId, provider, generation, retryRequested)
        if (pollerExisted && retryRequested) {
          this.poller?.requestRunNow(() => this.publishChecking())
        }
        this.startLifetimeSweep(accountId, provider, generation)
      })
      .catch((error) => {
        if (generation === this.generation) this.running = false
        if (generation !== this.generation) {
          if (this.context.isSignedIn()) void this.resumeOnlineWork()
          return
        }
        const failure = this.publishForegroundFailure(error, '[sync] failed after backfill')
        if (this.backfillRetryGeneration === generation) {
          this.backfillRetryGeneration = null
          this.startSync()
        } else if (failure.phase === 'offline') {
          this.scheduleOfflineRetry(generation)
        }
      })
  }

  private startHistoryPoller(
    accountId: string,
    provider: GmailMailProvider,
    generation: number,
    runImmediately = false
  ): void {
    if (this.stopped || generation !== this.generation || this.poller) return
    this.poller = new HistoryPoller({
      db: this.context.db,
      accountId,
      provider,
      isForeground: this.context.isForeground,
      recoverExpiredHistory: () => this.recoverExpiredHistory(accountId, provider, generation),
      onCycleStart: () => {
        if (generation !== this.generation) return
        this.pollerRunning = true
      },
      onCycleComplete: (changed) => {
        if (generation !== this.generation) return
        this.pollerRunning = false
        this.foregroundFailure = null
        this.publishSettledState()
        if (changed) this.context.broadcastMailChanged()
      },
      onError: (error) => {
        if (generation !== this.generation) return
        // Never clear `running` here: a concurrent backfill owns that flag,
        // and recovery's own finally block already releases it.
        this.pollerRunning = false
        this.publishForegroundFailure(error, '[sync] history poll failed')
      },
      wakeThread: (threadId) => this.context.getSnoozeScheduler()?.wakeThread(threadId),
      syncDrafts: () => syncRemoteDrafts(this.context.db, accountId, provider),
      kickExecutor: () => {
        void this.context.getActionExecutor()?.trigger()
        void this.context.getDraftMirrorExecutor()?.trigger()
        void this.context.getOutboxSender()?.trigger()
      }
    })
    this.poller.start()
    if (runImmediately) this.poller.requestRunNow(() => this.publishChecking())
  }

  private startLifetimeSweep(accountId: string, provider: GmailMailProvider, generation: number): void {
    if (this.stopped || this.lifetimeRunning || generation !== this.generation || this.context.isSeeded()) {
      return
    }
    this.lifetimeRetry.clear()
    this.lifetimeRunning = true
    const lifetimeRunId = ++this.lifetimeRunId
    let failed = false
    console.log(`[sync] lifetime header sweep started for ${accountId}`)
    void runLifetimeSweep(
      this.context.db,
      provider,
      accountId,
      {
        onProgress: (progress) => {
          if (generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) return
          this.publishLifetimeProgress(progress)
        },
        onError: (error) => {
          if (generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) return
          failed = true
          this.lifetimeRunning = false
          if (this.publishLifetimePause(error, '[sync] lifetime header sweep failed')) {
            this.scheduleLifetimeRetry(accountId, provider, generation)
          }
        }
      },
      {
        shouldContinue: () =>
          !this.stopped &&
          generation === this.generation &&
          lifetimeRunId === this.lifetimeRunId &&
          this.context.currentAccountId() === accountId,
        shouldYield: () => this.shouldYieldLifetime(accountId)
      }
    )
      .then((result) => {
        if (generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) return
        this.lifetimeRunning = false
        if (!result || failed) return
        this.lifetimeProgress = null
        this.publishSettledState()
        console.log(`[sync] lifetime header sweep done: ${result.threadCount} threads for ${accountId}`)
      })
      .catch((error) => {
        if (generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) return
        this.lifetimeRunning = false
        if (this.publishLifetimePause(error, '[sync] failed after lifetime header sweep')) {
          this.scheduleLifetimeRetry(accountId, provider, generation)
        }
      })
  }

  private publishLifetimeProgress(progress: LifetimeSweepProgress): void {
    const { mailChanged, ...details } = progress
    this.lifetimeProgress = { phase: 'indexing', stage: 'lifetime', ...details }
    if (!this.running && !this.pollerRunning && !this.foregroundFailure) {
      this.setState(this.lifetimeProgress)
    }
    if (mailChanged) this.context.broadcastMailChanged()
  }

  private publishSettledState(): void {
    if (this.running || this.pollerRunning) return
    this.setState(this.foregroundFailure ?? this.lifetimeProgress ?? { phase: 'idle' })
  }

  private shouldYieldLifetime(accountId: string): boolean {
    if (this.running || this.pollerRunning || this.context.hasForegroundProviderWork(accountId)) return true
    return Boolean(
      this.context.getActionExecutor()?.isRunning() ||
        this.context.getDraftMirrorExecutor()?.isRunning() ||
        this.context.getOutboxSender()?.isRunning()
    )
  }

  private publishChecking(): void {
    this.foregroundFailure = null
    this.setState({ phase: 'checking' })
  }

  private async recoverExpiredHistory(
    accountId: string,
    provider: GmailMailProvider,
    generation: number
  ): Promise<void> {
    if (this.stopped || generation !== this.generation) {
      throw new Error('authentication session changed')
    }
    // The poller can hit an expired checkpoint while a resumed backfill is
    // mid-flight. Two concurrent backfills would race the cursor, so defer:
    // the next poll cycle re-detects the expiry once the backfill finishes.
    if (this.running) {
      console.warn('[sync] history recovery deferred — backfill in progress')
      return
    }
    this.running = true
    this.setState({ phase: 'syncing', stage: 'metadata', threadsDone: 0 })
    let failure: unknown = new Error('history recovery backfill failed')
    try {
      const result = await runInboxBackfill(
        this.context.db,
        provider,
        {
          onProgress: (progress) => {
            if (generation !== this.generation) return
            const { mailChanged, ...stateProgress } = progress
            this.setState({ phase: 'syncing', ...stateProgress })
            if (mailChanged) this.context.broadcastMailChanged()
          },
          onError: (error) => {
            failure = error
          }
        },
        { recovery: true }
      )
      if (!result) throw failure
      if (generation !== this.generation) throw new Error('authentication session changed')
      reconcileInboxMembership(this.context.db, accountId, result.inboxThreadIds)
      await reconcilePurgeableMembership(this.context.db, accountId, provider, 'SPAM', result.spamThreadIds)
      await reconcilePurgeableMembership(this.context.db, accountId, provider, 'TRASH', result.trashThreadIds)
    } finally {
      if (generation === this.generation) this.running = false
      else if (this.context.isSignedIn()) void this.resumeOnlineWork()
    }
  }

  private stopHistoryPoller(): void {
    this.poller?.stop()
    this.poller = null
    this.pollerRunning = false
  }
}
