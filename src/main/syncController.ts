import type { SyncState } from '../shared/mail'
import { pendingActionCount } from './actions'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import type { GmailMailProvider } from './gmail/provider'
import type { SnoozeScheduler } from './scheduler'
import { runInboxBackfill } from './sync/backfill'
import { syncFailureState } from './sync/failure'
import { HistoryPoller, reconcileInboxMembership } from './sync/poller'
import { OfflineRetryScheduler, syncRetryRoute } from './sync/retry'
import { sameSyncState } from './sync/state'

interface SyncControllerContext {
  db: Db
  currentAccountId: () => string | null
  isSignedIn: () => boolean
  isSeeded: () => boolean
  makeProvider: (generation: number) => GmailMailProvider | null
  /** Drives the poller's foreground/background cadence; owned by index.ts so this stays Electron-free. */
  isForeground: () => boolean
  broadcastState: (state: SyncState) => void
  broadcastMailChanged: () => void
  getActionExecutor: () => ActionExecutor | null
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
  private backfillRetryGeneration: number | null = null
  private generation = 0
  private poller: HistoryPoller | null = null
  private readonly offlineRetry = new OfflineRetryScheduler(15_000)

  constructor(private readonly context: SyncControllerContext) {}

  getState(): SyncState {
    return this.state
  }

  getGeneration(): number {
    return this.generation
  }

  /** E2E-only seam for exercising renderer state transitions through real IPC. */
  setStateForTest(state: SyncState): void {
    this.setState(state)
  }

  onSignIn(): void {
    this.resetSession()
    void this.resumeOnlineWork()
  }

  onSignOut(): void {
    this.resetSession()
    this.setState({ phase: 'idle' })
  }

  stop(): void {
    this.stopHistoryPoller()
    this.offlineRetry.clear()
  }

  retry(): void {
    this.offlineRetry.clear()
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
      this.poller?.requestRunNow(() => this.setState({ phase: 'checking' }))
    } else if (route === 'queue-backfill') {
      this.backfillRetryGeneration = this.generation
    } else {
      this.startSync()
    }
    void this.context.getActionExecutor()?.trigger()
  }

  async resumeOnlineWork(): Promise<void> {
    // Remote changes must keep flowing even when a queued local action is in
    // Gmail's retry/backoff loop. The executor and history poller are independent.
    if (this.context.isSignedIn()) this.startSync()
    await this.context.getActionExecutor()?.trigger()
    // A sign-out/account switch can make an active drain finish early. A second
    // pass picks up the newly active account.
    await this.context.getActionExecutor()?.trigger()
  }

  private resetSession(): void {
    this.stopHistoryPoller()
    this.offlineRetry.clear()
    this.backfillRetryGeneration = null
    this.running = false
    this.generation++
  }

  private setState(state: SyncState): void {
    if (sameSyncState(this.state, state)) return
    this.state = state
    this.context.broadcastState(state)
  }

  private publishFailure(error: unknown, prefix: string): SyncState {
    const next = syncFailureState(error)
    this.setState(next)
    console.error(`${prefix}: ${next.message}`)
    return next
  }

  private scheduleOfflineRetry(generation: number): void {
    this.offlineRetry.schedule(
      () => generation === this.generation && this.context.isSignedIn(),
      () => this.startSync()
    )
  }

  private startSync(): void {
    if (this.running || this.context.isSeeded() || this.poller) return
    this.offlineRetry.clear()
    const generation = this.generation
    const accountId = this.context.currentAccountId()
    const provider = this.context.makeProvider(generation)
    if (!accountId) return
    if (!provider) {
      const message = 'OAuth configuration unavailable — add oauth.config.json'
      this.setState({ phase: 'error', message })
      console.error(`[sync] failed: ${message}`)
      return
    }
    const state = this.context.db
      .prepare('SELECT backfill_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null } | undefined
    if (state?.backfill_cursor === 'done') {
      this.startHistoryPoller(accountId, provider, generation, true)
      return
    }
    if (this.backfillRetryGeneration === generation) this.backfillRetryGeneration = null
    this.running = true
    this.setState({ phase: 'syncing', stage: 'metadata', threadsDone: 0 })
    console.log('[sync] inbox backfill started')
    void runInboxBackfill(this.context.db, provider, {
      onProgress: (progress) => {
        if (generation !== this.generation) return
        const { mailChanged, ...stateProgress } = progress
        this.setState({ phase: 'syncing', ...stateProgress })
        if (mailChanged) this.context.broadcastMailChanged()
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.running = false
        const failure = this.publishFailure(error, '[sync] failed')
        if (this.backfillRetryGeneration !== generation && failure.phase === 'offline') {
          this.scheduleOfflineRetry(generation)
        }
      }
    })
      .then((result) => {
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
        this.setState({ phase: 'idle' })
        this.context.broadcastMailChanged()
        console.log(`[sync] backfill done: ${result.threadCount} inbox threads for ${accountId}`)
        this.startHistoryPoller(accountId, provider, generation, retryRequested)
      })
      .catch((error) => {
        if (generation === this.generation) this.running = false
        if (generation !== this.generation) {
          if (this.context.isSignedIn()) void this.resumeOnlineWork()
          return
        }
        const failure = this.publishFailure(error, '[sync] failed after backfill')
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
    if (generation !== this.generation || this.poller) return
    this.poller = new HistoryPoller({
      db: this.context.db,
      accountId,
      provider,
      isForeground: this.context.isForeground,
      recoverExpiredHistory: () => this.recoverExpiredHistory(accountId, provider, generation),
      onCycleComplete: (changed) => {
        if (generation !== this.generation) return
        this.setState({ phase: 'idle' })
        if (changed) this.context.broadcastMailChanged()
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.running = false
        this.publishFailure(error, '[sync] history poll failed')
      },
      wakeThread: (threadId) => this.context.getSnoozeScheduler()?.wakeThread(threadId),
      kickExecutor: () => {
        if (pendingActionCount(this.context.db, accountId) > 0) {
          void this.context.getActionExecutor()?.trigger()
        }
      }
    })
    this.poller.start()
    if (runImmediately) this.poller.requestRunNow(() => this.setState({ phase: 'checking' }))
  }

  private async recoverExpiredHistory(
    accountId: string,
    provider: GmailMailProvider,
    generation: number
  ): Promise<void> {
    if (generation !== this.generation) throw new Error('authentication session changed')
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
    } finally {
      if (generation === this.generation) this.running = false
      else if (this.context.isSignedIn()) void this.resumeOnlineWork()
    }
  }

  private stopHistoryPoller(): void {
    this.poller?.stop()
    this.poller = null
  }
}
