import type { MailChangeReason } from '../shared/ipc'
import type { SyncState } from '../shared/mail'
import type { ActionExecutor } from './actions/executor'
import type { Db } from './db'
import { runMailboxMembershipBackfill } from './db/mailboxMembership'
import {
  evaluateThreadFollowUp,
  followUpRecoveryPending,
  liveFollowUpThreadIds,
  resolveFollowUpOrigins,
  setFollowUpRecoveryPending,
  settleFollowUpCandidates
} from './followUps'
import { GmailApiError } from './gmail/client'
import type { GmailMailProvider } from './gmail/provider'
import { syncRemoteDrafts } from './outbox/draftSync'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import { syncPrimarySendAs } from './outbox/sendAs'
import type { OutboxSender } from './outbox/sender'
import type { SnoozeScheduler } from './scheduler'
import { type AttachmentFlagProgress, runAttachmentFlagWalk } from './sync/attachmentFlags'
import { planBackfillStart, runInboxBackfill } from './sync/backfill'
import { reconcileThreadExistence } from './sync/existenceSweep'
import { errorMessage, isOfflineFailure, syncFailureState } from './sync/failure'
import { fetchAndCacheThread } from './sync/fetchThread'
import { runFtsBackfill } from './sync/ftsBackfill'
import { syncLabelCatalog } from './sync/labels'
import { effectiveLifetimeThreadCap } from './sync/lifetimeCap'
import { type LifetimeSweepProgress, runLifetimeSweep } from './sync/lifetimeSweep'
import { deleteThread } from './sync/persist'
import type { NewMail } from './sync/poller'
import { HistoryPoller, reconcileInboxMembership, reconcilePurgeableMembership } from './sync/poller'
import { OfflineRetryScheduler, syncRetryRoute } from './sync/retry'
import { runSplitMetadataRebuild, type SplitMetadataProgress } from './sync/splitMetadata'
import { sameSyncState } from './sync/state'
import { FTS_RETRY_MS, LIFETIME_RETRY_MS, OFFLINE_SYNC_RETRY_MS } from './sync/tuning'

interface SyncControllerContext {
  db: Db
  currentAccountId: () => string | null
  isSignedIn: () => boolean
  isSeeded: () => boolean
  makeProvider: () => GmailMailProvider | null
  /** Drives the poller's foreground/background cadence; owned by index.ts so this stays Electron-free. */
  isForeground: () => boolean
  /** True while an interactive body or attachment request is using Gmail for this account. */
  hasForegroundProviderWork: (accountId: string) => boolean
  mailRevision: () => number
  broadcastState: (state: SyncState) => void
  broadcastMailChanged: (reason?: MailChangeReason) => void
  getActionExecutor: () => ActionExecutor | null
  getDraftMirrorExecutor: () => DraftMirrorExecutor | null
  getOutboxSender: () => OutboxSender | null
  getSnoozeScheduler: () => SnoozeScheduler | null
  /**
   * Gate for the Gmail-heavy historical chain (lifetime sweep → attachment
   * flags → split metadata). With several accounts, the runtime serializes
   * these across accounts, active account first (F18); the resolved release
   * callback must be called exactly once when the chain settles. Absent → run
   * immediately (single-account tests).
   */
  acquireIndexingSlot?: (accountId: string) => Promise<() => void>
  /**
   * True while the active account is waiting on the indexing slot this
   * account holds. The chain checks it at every page boundary and, when set,
   * settles early and re-queues itself — the durable cursors are what make
   * that hand-over free (F18, §9 #21(g)).
   */
  shouldPreemptIndexing?: (accountId: string) => boolean
  /** Test-only pacing overrides threaded through the historical chain stages. */
  lifetimePacing?: { requestIntervalMs?: number; pagePauseMs?: number; foregroundYieldMs?: number }
}

interface LocalBackfillRun {
  accountId: string
  generation: number
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
  private ftsBackfillRun: LocalBackfillRun | null = null
  private mailboxBackfillRun: LocalBackfillRun | null = null
  private pendingFtsBackfill: LocalBackfillRun | null = null
  private pendingMailboxBackfill: LocalBackfillRun | null = null
  private lifetimeProgress: Extract<SyncState, { phase: 'indexing' }> | null = null
  private foregroundFailure: Extract<SyncState, { phase: 'offline' | 'error' }> | null = null
  private inboxRecoveryPending = false
  private pollerRunning = false
  private stopped = false
  private backfillRetryGeneration: number | null = null
  private generation = 0
  private lifetimeRunId = 0
  private poller: HistoryPoller | null = null
  private readonly offlineRetry = new OfflineRetryScheduler(OFFLINE_SYNC_RETRY_MS)
  private readonly lifetimeRetry = new OfflineRetryScheduler(LIFETIME_RETRY_MS)
  private readonly ftsRetry = new OfflineRetryScheduler(FTS_RETRY_MS)

  constructor(private readonly context: SyncControllerContext) {}

  getState(): SyncState {
    return this.state
  }

  isInboxRecoveryPending(): boolean {
    return this.inboxRecoveryPending
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

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.resetSession()
  }

  /**
   * Cancel the in-flight historical chain's writes before a cap change
   * persists (T32A). The canceled run observes the stale run id at its next
   * safe point, stops without writing, and still releases the shared indexing
   * slot exactly once in its own settle path; nothing else — auth, pollers,
   * send executors — is touched.
   */
  invalidateLifetimeChain(): void {
    if (this.stopped) return
    this.lifetimeRunId++
    this.lifetimeRunning = false
    this.lifetimeRetry.clear()
  }

  /**
   * Schedule this account's historical work again after a cap change. The
   * replacement chain reads the saved cap at its start and, when the shared
   * indexing slot is held by the settling old chain (or another account), it
   * waits its turn — active-account priority and preemption unchanged. An
   * offline or paused-auth account simply applies the saved value on resume.
   */
  restartLifetimeChain(): void {
    if (this.stopped || !this.context.isSignedIn()) return
    const generation = this.generation
    const accountId = this.context.currentAccountId()
    if (!accountId) return
    const provider = this.context.makeProvider()
    if (!provider) return
    this.startLifetimeSweep(accountId, provider, generation)
  }

  retry(): void {
    if (this.stopped) return
    this.offlineRetry.clear()
    this.lifetimeRetry.clear()
    this.ftsRetry.clear()
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
    this.ftsRetry.clear()
    this.backfillRetryGeneration = null
    this.pendingFtsBackfill = null
    this.pendingMailboxBackfill = null
    this.running = false
    this.lifetimeRunning = false
    this.lifetimeProgress = null
    this.foregroundFailure = null
    this.inboxRecoveryPending = false
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
      stage: previous?.stage ?? 'lifetime',
      threadsDone: previous?.threadsDone ?? 0,
      ...(previous?.threadsTotal === undefined ? {} : { threadsTotal: previous.threadsTotal }),
      ...(previous?.messagesTotal === undefined ? {} : { messagesTotal: previous.messagesTotal }),
      ...(previous?.etaMs === undefined ? {} : { etaMs: previous.etaMs }),
      ...(previous?.quotaWaitMs === undefined ? {} : { quotaWaitMs: previous.quotaWaitMs }),
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

  private scheduleFtsRetry(accountId: string, generation: number): void {
    this.ftsRetry.schedule(
      () =>
        !this.stopped &&
        generation === this.generation &&
        this.context.isSignedIn() &&
        this.context.currentAccountId() === accountId,
      () => this.startFtsBackfill(accountId, generation)
    )
  }

  /**
   * Fill derived mailbox membership for a profile whose rows predate the table.
   * Unlike the other local passes this starts before Gmail work: mailbox counts
   * and the All Mail list read the table, so a manually upgraded profile shows
   * them incomplete until this finishes. A freshly synced store maintains
   * membership inline and this returns on its first batch.
   */
  private startMailboxMembershipBackfill(accountId: string, generation: number): void {
    if (this.stopped || generation !== this.generation) return
    const requestedRun = { accountId, generation }
    if (this.mailboxBackfillRun) {
      // Reauthentication cancels the old pass at its next batch boundary. Keep
      // the replacement request until that pass exits so neither run is lost
      // and two passes never write the same cursor concurrently.
      if (
        this.mailboxBackfillRun.accountId !== accountId ||
        this.mailboxBackfillRun.generation !== generation
      ) {
        this.pendingMailboxBackfill = requestedRun
      }
      return
    }
    this.pendingMailboxBackfill = null
    this.mailboxBackfillRun = requestedRun
    void runMailboxMembershipBackfill(this.context.db, accountId, {
      shouldContinue: () =>
        !this.stopped && generation === this.generation && this.context.currentAccountId() === accountId
    })
      .then((result) => {
        // A canceled generation can still have committed batches. This callback
        // is account-bound, and the replacement may find no work left to publish.
        if (!this.stopped && result.threadsIndexed > 0) {
          console.log(`[sync] mailbox membership filled for ${result.threadsIndexed} threads`)
          this.context.broadcastMailChanged()
        }
      })
      .catch((error) => {
        console.error(`[sync] mailbox membership backfill failed: ${errorMessage(error)}`)
      })
      .finally(() => {
        if (this.mailboxBackfillRun !== requestedRun) return
        this.mailboxBackfillRun = null
        const pending = this.pendingMailboxBackfill
        this.pendingMailboxBackfill = null
        if (pending) this.startMailboxMembershipBackfill(pending.accountId, pending.generation)
      })
  }

  private startSync(): void {
    // An alive poller no longer implies the backfill finished (it starts at
    // interactive-ready), so always route through the cursor plan below;
    // startHistoryPoller no-ops when the poller already exists.
    if (this.stopped || this.running || this.context.isSeeded()) return
    this.offlineRetry.clear()
    const generation = this.generation
    const accountId = this.context.currentAccountId()
    const provider = this.context.makeProvider()
    if (!accountId) return
    // Ahead of the provider check: membership is local, so an unconfigured or
    // offline client still gets working counts and All Mail.
    this.startMailboxMembershipBackfill(accountId, generation)
    if (!provider) {
      const message = 'OAuth configuration unavailable — add oauth.config.json'
      this.foregroundFailure = { phase: 'error', message }
      this.setState(this.foregroundFailure)
      console.error(`[sync] failed: ${message}`)
      return
    }
    this.foregroundFailure = null
    void syncPrimarySendAs(this.context.db, accountId, provider, { priority: 'background' }).catch((error) =>
      console.warn(`[sync] send-as refresh failed: ${errorMessage(error)}`)
    )
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
      },
      onMetric: (metric) => {
        if (generation !== this.generation) return
        console.log(`[sync:metric] ${JSON.stringify(metric)}`)
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
        this.inboxRecoveryPending = false
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
        // A crash after recovery advanced its checkpoint but before the
        // follow-up re-checks finished leaves the persisted guard set; the
        // ordinary cycle finishes those checks so returns can resume (T35).
        if (followUpRecoveryPending(this.context.db, accountId)) {
          void this.finishFollowUpRecovery(accountId, provider, generation)
        }
      },
      onError: (error) => {
        if (generation !== this.generation) return
        // Never clear `running` here: a concurrent backfill owns that flag,
        // and recovery's own finally block already releases it.
        this.pollerRunning = false
        this.publishForegroundFailure(error, '[sync] history poll failed')
      },
      wakeThread: (threadId) => this.context.getSnoozeScheduler()?.wakeThread(threadId),
      settleFollowUps: (candidates) => this.settleFollowUps(accountId, candidates),
      syncLabels: () => syncLabelCatalog(this.context.db, accountId, provider),
      syncSendAs: () =>
        syncPrimarySendAs(this.context.db, accountId, provider, { priority: 'polling' }).then(
          () => undefined
        ),
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
    const acquireSlot = this.context.acquireIndexingSlot
    if (!acquireSlot) {
      // No cross-account gate configured: start synchronously, as always.
      this.runLifetimeChain(accountId, provider, generation, lifetimeRunId, () => {})
      return
    }
    void acquireSlot(accountId).then((release) => {
      // The session can end while this account waited its turn for the slot.
      if (this.stopped || generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) {
        if (lifetimeRunId === this.lifetimeRunId) this.lifetimeRunning = false
        release()
        return
      }
      this.runLifetimeChain(accountId, provider, generation, lifetimeRunId, release)
    })
  }

  private runLifetimeChain(
    accountId: string,
    provider: GmailMailProvider,
    generation: number,
    lifetimeRunId: number,
    releaseSlot: () => void
  ): void {
    let failed = false
    console.log(`[sync] lifetime header sweep started for ${accountId}`)
    const active = (): boolean => generation === this.generation && lifetimeRunId === this.lifetimeRunId
    // Both passes share one posture: the same cancellation guard, the same
    // yield-to-foreground rule, and the same retry ladder. A preemption ask —
    // the active account waiting on the slot this account holds — reads as a
    // cancellation at the next page boundary; the settle handlers below
    // re-queue instead of parking (F18).
    const pacing = {
      shouldContinue: () =>
        !this.stopped &&
        active() &&
        this.context.currentAccountId() === accountId &&
        !this.preemptRequested(accountId),
      shouldYield: () => this.shouldYieldLifetime(accountId),
      snapshotRevision: this.context.mailRevision,
      // The saved per-account limit is read at every chain start — restart,
      // reauthentication, retry, and slot handover included (F2/F15, T32A).
      threadCap: effectiveLifetimeThreadCap(this.context.db, accountId),
      ...this.context.lifetimePacing
    }
    const pause = (error: unknown, prefix: string): void => {
      failed = true
      this.lifetimeRunning = false
      if (this.publishLifetimePause(error, prefix)) {
        this.scheduleLifetimeRetry(accountId, provider, generation)
      }
    }
    void runLifetimeSweep(
      this.context.db,
      provider,
      accountId,
      {
        onProgress: (progress) => {
          if (!active()) return
          this.publishLifetimeProgress(progress)
        },
        onError: (error) => {
          if (!active()) return
          pause(error, '[sync] lifetime header sweep failed')
        }
      },
      pacing
    )
      .then(async (result) => {
        if (!active()) return
        if (!result || failed) {
          if (!failed && this.requeueAfterPreemption(accountId, provider, generation)) return
          this.lifetimeRunning = false
          return
        }
        console.log(`[sync] lifetime header sweep done: ${result.threadCount} threads for ${accountId}`)
        console.log(
          `[sync:metric] ${JSON.stringify({
            kind: 'lifetime-complete',
            threadsDone: result.threadCount,
            elapsedMs: result.elapsedMs,
            ...(result.threadsPerMinute === undefined ? {} : { threadsPerMinute: result.threadsPerMinute }),
            quotaWaitMs: result.quotaWaitMs
          })}`
        )
        // The ids-only attachment tail runs on the sweep's completion, including
        // the launch where the sweep itself has nothing left to do.
        const flags = await runAttachmentFlagWalk(
          this.context.db,
          provider,
          accountId,
          {
            onProgress: (progress) => {
              if (!active()) return
              this.publishAttachmentProgress(progress)
            },
            onError: (error) => {
              if (!active()) return
              pause(error, '[sync] attachment index failed')
            }
          },
          pacing
        )
        if (!active()) return
        if (!flags || failed) {
          if (!failed && this.requeueAfterPreemption(accountId, provider, generation)) return
          this.lifetimeRunning = false
          return
        }
        const splitMetadata = await runSplitMetadataRebuild(
          this.context.db,
          provider,
          accountId,
          {
            onProgress: (progress) => {
              if (!active()) return
              this.publishSplitMetadataProgress(progress)
            },
            onError: (error) => {
              if (!active()) return
              pause(error, '[sync] split metadata rebuild failed')
            }
          },
          pacing
        )
        if (!active()) return
        if (!splitMetadata || failed) {
          if (!failed && this.requeueAfterPreemption(accountId, provider, generation)) return
          this.lifetimeRunning = false
          return
        }
        this.lifetimeRunning = false
        if (splitMetadata.threadsRefreshed > 0) {
          console.log(
            `[sync] split metadata rebuild done: ${splitMetadata.threadsRefreshed} threads refreshed for ${accountId}`
          )
        }
        this.lifetimeProgress = null
        this.publishSettledState()
        if (flags.threadsFlagged > 0) {
          console.log(
            `[sync] attachment index done: ${flags.threadsFlagged} threads flagged for ${accountId}`
          )
        }
        // The purely local FTS backfill runs behind every Gmail-backed cursor.
        this.startFtsBackfill(accountId, generation)
      })
      .catch((error) => {
        if (generation !== this.generation || lifetimeRunId !== this.lifetimeRunId) return
        this.lifetimeRunning = false
        if (this.publishLifetimePause(error, '[sync] failed after lifetime header sweep')) {
          this.scheduleLifetimeRetry(accountId, provider, generation)
        }
      })
      // Release on every settle — completion, pause, or cancellation. A paused
      // chain re-acquires when its retry ladder re-enters startLifetimeSweep.
      .finally(releaseSlot)
  }

  private startFtsBackfill(accountId: string, generation: number): void {
    if (this.stopped || generation !== this.generation) return
    const requestedRun = { accountId, generation }
    if (this.ftsBackfillRun) {
      // A duplicate request for the active session needs no second pass. A
      // newer session must start after the stale pass observes cancellation.
      if (this.ftsBackfillRun.accountId !== accountId || this.ftsBackfillRun.generation !== generation) {
        this.pendingFtsBackfill = requestedRun
      }
      return
    }
    this.pendingFtsBackfill = null
    this.ftsRetry.clear()
    this.ftsBackfillRun = requestedRun
    // Deliberately decoupled from `lifetimeRunId`: a manual retry that re-walks
    // the already-done lifetime chain must not cancel a mid-flight local pass.
    let failed = false
    void runFtsBackfill(
      this.context.db,
      accountId,
      {
        onProgress: () => {},
        onError: (error) => {
          failed = true
          console.error(`[sync] search index backfill failed: ${errorMessage(error)}`)
        }
      },
      {
        shouldContinue: () =>
          !this.stopped && generation === this.generation && this.context.currentAccountId() === accountId,
        shouldYield: () => this.shouldYieldLifetime(accountId)
      }
    )
      .then((result) => {
        if (!result) {
          if (failed) this.scheduleFtsRetry(accountId, generation)
          return
        }
        if (result.messagesIndexed > 0) {
          console.log(
            `[sync] search index backfill done: ${result.messagesIndexed} messages indexed for ${accountId}`
          )
        }
      })
      .finally(() => {
        if (this.ftsBackfillRun !== requestedRun) return
        this.ftsBackfillRun = null
        const pending = this.pendingFtsBackfill
        this.pendingFtsBackfill = null
        if (
          !pending ||
          this.stopped ||
          pending.generation !== this.generation ||
          this.context.currentAccountId() !== pending.accountId
        ) {
          return
        }
        this.startFtsBackfill(pending.accountId, pending.generation)
      })
  }

  private publishLifetimeProgress(progress: LifetimeSweepProgress): void {
    this.lifetimeProgress = { phase: 'indexing', stage: 'lifetime', ...progress }
    if (!this.running && !this.pollerRunning && !this.foregroundFailure) {
      this.setState(this.lifetimeProgress)
    }
    // Lifetime rows are deliberately hidden from every current mailbox. Their
    // headers and contact projections are queried on demand, so broadcasting a
    // visible-mail refresh here only makes the renderer rebuild its list and
    // reader after every archival page with no possible UI change.
  }

  private publishAttachmentProgress(progress: AttachmentFlagProgress): void {
    const { mailChanged, threadsFlagged, ...details } = progress
    this.lifetimeProgress = {
      phase: 'indexing',
      stage: 'attachments',
      threadsDone: threadsFlagged,
      ...details
    }
    if (!this.running && !this.pollerRunning && !this.foregroundFailure) {
      this.setState(this.lifetimeProgress)
    }
    // Raising the flag repaints attachment chips in the already-rendered list.
    if (mailChanged) this.context.broadcastMailChanged()
  }

  private publishSplitMetadataProgress(progress: SplitMetadataProgress): void {
    const { mailChanged, ...details } = progress
    this.lifetimeProgress = {
      phase: 'indexing',
      stage: 'split-metadata',
      ...details
    }
    if (!this.running && !this.pollerRunning && !this.foregroundFailure) {
      this.setState(this.lifetimeProgress)
    }
    if (mailChanged) this.context.broadcastMailChanged('split-metadata')
  }

  private publishSettledState(): void {
    if (this.running || this.pollerRunning) return
    this.setState(this.foregroundFailure ?? this.lifetimeProgress ?? { phase: 'idle' })
  }

  private preemptRequested(accountId: string): boolean {
    return this.context.shouldPreemptIndexing?.(accountId) ?? false
  }

  /**
   * A chain stage that halted because the active account wants the slot
   * settles (its `.finally` releases the slot to that account) and re-queues
   * itself here, so the preempted cursor resumes once the slot comes back.
   * Returns false when the halt was a real cancellation — sign-out, session
   * reset, shutdown — which must park, not re-queue. When those all still
   * hold, the only remaining halt cause was a preemption ask, so re-queue
   * without re-reading it: the ask can evaporate between the page boundary
   * and this settle (the active account switched again), and parking then
   * would strand the chain with no retry scheduled. A re-queue with nobody
   * waiting is free — the slot grants immediately and the durable cursor
   * resumes where it stopped.
   */
  private requeueAfterPreemption(
    accountId: string,
    provider: GmailMailProvider,
    generation: number
  ): boolean {
    if (this.stopped || generation !== this.generation || this.context.currentAccountId() !== accountId) {
      return false
    }
    console.log(`[sync] historical indexing preempted by the active account; requeueing ${accountId}`)
    this.lifetimeRunning = false
    this.startLifetimeSweep(accountId, provider, generation)
    return true
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
    this.inboxRecoveryPending = true
    this.running = true
    // Expired history means a reply may exist that only an authoritative
    // snapshot can show: no follow-up may return until every live one has
    // been re-checked. Persisted, so a restart mid-recovery stays deferred.
    setFollowUpRecoveryPending(this.context.db, accountId, true)
    this.setState({ phase: 'syncing', stage: 'metadata', threadsDone: 0 })
    let failure: unknown = new Error('history recovery backfill failed')
    try {
      // Keep the expired checkpoint durable until tombstoning finishes. If the
      // utility process stops mid-pass, the next launch must detect expiry again.
      const existence = await reconcileThreadExistence(this.context.db, accountId, provider, {
        shouldContinue: () =>
          !this.stopped && generation === this.generation && this.context.currentAccountId() === accountId
      })
      if (!existence) throw new Error('authentication session changed')
      if (existence.deletedThreadIds.length > 0) {
        console.log(
          `[sync] expiry recovery removed ${existence.deletedThreadIds.length} missing threads for ${accountId}`
        )
        // Publish the durable deletions now. A later backfill failure must not
        // leave the renderer showing rows that are already gone from SQLite.
        this.context.broadcastMailChanged()
      }

      this.setState({ phase: 'syncing', stage: 'metadata', threadsDone: 0 })
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
          },
          onMetric: (metric) => {
            if (generation !== this.generation) return
            console.log(`[sync:metric] ${JSON.stringify({ ...metric, recovery: true })}`)
          }
        },
        { recovery: true }
      )
      if (!result) throw failure
      if (generation !== this.generation) throw new Error('authentication session changed')
      reconcileInboxMembership(this.context.db, accountId, result.inboxThreadIds)
      await reconcilePurgeableMembership(this.context.db, accountId, provider, 'SPAM', result.spamThreadIds)
      await reconcilePurgeableMembership(this.context.db, accountId, provider, 'TRASH', result.trashThreadIds)
      // Recovery re-lists INBOX only; a thread with a live follow-up can be
      // archived, so each one is refreshed authoritatively before returns
      // resume. A failed read keeps the guard set and recovery retryable.
      await this.refreshLiveFollowUps(accountId, provider, generation)
      setFollowUpRecoveryPending(this.context.db, accountId, false)
      this.context.getSnoozeScheduler()?.refresh()
      this.inboxRecoveryPending = false
    } finally {
      if (generation === this.generation) this.running = false
      else if (this.context.isSignedIn()) void this.resumeOnlineWork()
    }
  }

  /** Poller-cycle hook (T35): settle live follow-ups against the refetched store. */
  private settleFollowUps(accountId: string, candidates: NewMail[]): void {
    const changed = settleFollowUpCandidates(
      this.context.db,
      accountId,
      candidates.map((candidate) => candidate.threadId)
    )
    if (changed) {
      this.context.getSnoozeScheduler()?.refresh()
      this.context.broadcastMailChanged()
    }
  }

  private async refreshLiveFollowUps(
    accountId: string,
    provider: GmailMailProvider,
    generation: number
  ): Promise<void> {
    const threadIds = liveFollowUpThreadIds(this.context.db, accountId)
    for (const threadId of threadIds) {
      if (this.stopped || generation !== this.generation) throw new Error('authentication session changed')
      try {
        await fetchAndCacheThread(this.context.db, accountId, provider, threadId, {
          format: 'full',
          priority: 'background'
        })
      } catch (error) {
        // A permanently gone thread takes its reminders with it; any other
        // failure keeps the guard set — never evidence of no reply.
        if (error instanceof GmailApiError && error.status === 404) {
          deleteThread(this.context.db, accountId, threadId)
          continue
        }
        throw error
      }
    }
    resolveFollowUpOrigins(this.context.db, accountId)
    let changed = false
    for (const threadId of threadIds) {
      if (evaluateThreadFollowUp(this.context.db, accountId, threadId)) changed = true
    }
    if (changed) this.context.broadcastMailChanged()
  }

  private followUpRecoveryRunning = false

  private async finishFollowUpRecovery(
    accountId: string,
    provider: GmailMailProvider,
    generation: number
  ): Promise<void> {
    if (this.followUpRecoveryRunning) return
    this.followUpRecoveryRunning = true
    try {
      await this.refreshLiveFollowUps(accountId, provider, generation)
      setFollowUpRecoveryPending(this.context.db, accountId, false)
      this.context.getSnoozeScheduler()?.refresh()
    } catch (error) {
      console.warn(`[sync] follow-up recovery re-check failed: ${errorMessage(error)}`)
    } finally {
      this.followUpRecoveryRunning = false
    }
  }

  private stopHistoryPoller(): void {
    this.poller?.stop()
    this.poller = null
    this.pollerRunning = false
  }
}
