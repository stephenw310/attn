import { join } from 'node:path'
import type { RevertedAction } from '../../shared/actionRevert'
import { type AccountSyncStatus, accountSyncPhase } from '../../shared/auth'
import type { InvokeChannel, MailChangeReason } from '../../shared/ipc'
import type { SystemMailboxCounts } from '../../shared/mail'
import { APP_SETTINGS_DEFAULTS } from '../../shared/settings'
import type { SplitState } from '../../shared/splits'
import { actionQueueStatus, clearUndo } from '../actions'
import { ActionExecutor } from '../actions/executor'
import { ActionRevertNotices } from '../actions/revertNotices'
import { type Db, openDatabase, schemaVersion } from '../db'
import { accountOutboxSpoolIds, purgeAccountRows } from '../db/purgeAccount'
import { countInboxUnread, countSystemMailboxes } from '../db/queries'
import { loadSeed, readSeedRemoteThreadIds, readSeedThread } from '../dev/seed'
import { GmailApiError, GmailClient } from '../gmail/client'
import { GmailMailProvider } from '../gmail/provider'
import { GmailQuotaLimiter } from '../gmail/quota'
import { DraftMirrorExecutor } from '../outbox/mirrorExecutor'
import { OutboxSender } from '../outbox/sender'
import { cleanOutboxSpool, deleteOutboxSpool, reconcileOutboxSpool } from '../outbox/spool'
import { resolveMessageSender, storedRemoteImagePolicy } from '../remoteImageStore'
import { SnoozeScheduler } from '../scheduler'
import { deleteSetting, readSetting, settingEnabled, writeSetting } from '../settings'
import { getSplitState, hasSplitSetup } from '../splits'
import { historyEvents, type NewMail } from '../sync/poller'
import type { ServerSearchProvider } from '../sync/serverSearch'
import { DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE } from '../sync/tuning'
import { SyncController } from '../syncController'
import { createServiceHandlers, type ServiceHandlers } from './handlers'
import { candidatesFor, notificationPausedUntil, setNotificationPausedUntil } from './notificationQueries'
import type {
  ServiceAccountAuth,
  ServiceAccountsState,
  ServiceControl,
  ServiceEvent,
  ServiceInitialize,
  ServiceOperation,
  ServiceReady
} from './protocol'
import type { ServiceSession } from './session'
import { TestOperations } from './testOperations'

export type ServiceEventSink = (event: ServiceEvent) => void

const ACTIVE_ACCOUNT_SETTING = 'activeAccountId'

interface AccountMailSummary {
  revision: number
  mailboxCounts?: SystemMailboxCounts
  splitState?: SplitState
}

/**
 * One signed-in account's live machinery (F18). Every worker is bound to this
 * account through its `accountId()` callback, so the executor classes stay
 * exactly as single-account as they were — the runtime holds one set per
 * account instead of one total.
 */
interface AccountSession extends ServiceSession {
  /** Null for seeded e2e accounts, which never talk to Gmail. */
  auth: ServiceAccountAuth | null
  readAbort: AbortController
}

/**
 * Serializes the Gmail-heavy historical chain across accounts: one holder at a
 * time, and a waiting active account is granted before waiting inactive ones.
 * Priority is evaluated when the slot is handed over, not when a waiter
 * queued, so a switch that happens mid-wait still puts the newly active
 * account ahead of everyone queued before it. The chain's durable cursors are
 * what make this safe — a queued account simply resumes where its cursor
 * points once granted. Exported for its focused unit tests.
 */
export class IndexingSlot {
  private holder: string | null = null
  private queue: Array<{ accountId: string; grant: (release: () => void) => void }> = []

  constructor(private readonly isPriority: (accountId: string) => boolean) {}

  acquire(accountId: string): Promise<() => void> {
    return new Promise((grant) => {
      if (!this.holder) {
        this.holder = accountId
        grant(this.makeRelease(accountId))
        return
      }
      this.queue.push({ accountId, grant })
    })
  }

  /**
   * True while `accountId` holds the slot, is not itself the priority account,
   * and a priority (active) account is waiting behind it. The holder's chain
   * polls this through its pacing hooks and hands the slot over at the next
   * page boundary — safe because every stage's cursor is durable (F18).
   */
  hasPriorityWaiter(accountId: string): boolean {
    return (
      this.holder === accountId &&
      !this.isPriority(accountId) &&
      this.queue.some((queued) => this.isPriority(queued.accountId))
    )
  }

  private makeRelease(accountId: string): () => void {
    let released = false
    return () => {
      if (released || this.holder !== accountId) return
      released = true
      const priorityIndex = this.queue.findIndex((queued) => this.isPriority(queued.accountId))
      const next = priorityIndex >= 0 ? this.queue.splice(priorityIndex, 1)[0] : this.queue.shift()
      if (!next) {
        this.holder = null
        return
      }
      this.holder = next.accountId
      next.grant(this.makeRelease(next.accountId))
    }
  }
}

export class ServiceRuntime {
  private readonly db: Db
  private readonly actionRevertNotices = new ActionRevertNotices()
  private readonly foregroundProviderWork = new Map<string, number>()
  private readonly gmailQuotaLimiters = new Map<string, GmailQuotaLimiter>()
  private readonly handlers: ServiceHandlers
  private readonly sessions = new Map<string, AccountSession>()
  private readonly accountOrder: string[] = []
  /**
   * Torn-down sessions whose draft/outbox workers are still quiescing (a Gmail
   * draft checkpoint gets up to five seconds — AGENTS.md shutdown invariant).
   * A successor session for the same account must wait these out: two live
   * executor sets could both select the same outbox row and double a
   * non-idempotent remote draft create.
   */
  private readonly retirements = new Map<string, Promise<void>>()
  /** Deferred session creations, awaitable by roster and switch operations. */
  private readonly pendingSessionCreations = new Map<string, Promise<void>>()
  /** The latest roster intent, consulted when a deferred re-create lands. */
  private desiredAccounts = new Map<string, ServiceAccountAuth | null>()
  private desiredActiveAccountId: string | null = null
  private readonly indexingSlot = new IndexingSlot((accountId) => accountId === this.activeAccountId)
  private config: ServiceAccountsState['config']
  private activeAccountId: string | null = null
  private focused: boolean
  private stopped = false
  private schedulersStarted = false
  private mailRevision = 0
  private readonly mailSummaryByAccount = new Map<string, AccountMailSummary>()
  private lastAccountStatuses = ''
  /**
   * Every e2e seam, or null outside ATTN_TEST_USER_DATA (REF-6). Production
   * code touches it only through the hooks below and `internal('test', …)`.
   */
  private readonly test: TestOperations | null

  private readonly onNewMail = (accountId: string, newMail: NewMail[]): void => {
    // Every signed-in account notifies, active or not (F12/F18). Batching is
    // per account per poll cycle by construction: each account's poller emits
    // its own newMail event, so one busy account summarizes while another's
    // two arrivals still show as detail toasts.
    if (!this.sessions.has(accountId)) return
    this.emit({
      kind: 'notification-candidates',
      accountId,
      candidates: candidatesFor(this.db, accountId, newMail),
      pausedUntil: notificationPausedUntil(this.db)
    })
  }

  static async create(input: ServiceInitialize, emit: ServiceEventSink): Promise<ServiceRuntime> {
    const runtime = new ServiceRuntime(input, emit)
    await runtime.start()
    return runtime
  }

  private constructor(
    private readonly input: ServiceInitialize,
    private readonly emit: ServiceEventSink
  ) {
    this.config = input.accounts.config
    this.focused = input.focused
    this.db = openDatabase(input.dbPath)

    let seedIds: string[] = []
    if (input.testSeed) {
      const existing = this.db.prepare('SELECT id FROM accounts ORDER BY rowid').all() as { id: string }[]
      if (existing.length === 0) {
        seedIds = loadSeed(this.db, input.testSeed).accountIds
      } else {
        // A removed-with-Keep account leaves its rows behind (F18, D3): the
        // persisted seed roster is what keeps it off the boot roster, exactly
        // as the token file does for real accounts. The persisted list also
        // carries the switcher order, so a settings reorder survives relaunch
        // in seeded runs the way the token file order does for real accounts.
        const persisted = readSetting(this.db, 'seedAccountIds')
        const existingIds = existing.map((row) => row.id)
        const wanted = persisted ? (JSON.parse(persisted) as string[]) : existingIds
        seedIds = wanted.filter((id) => existingIds.includes(id))
      }
      writeSetting(this.db, 'seedAccountIds', JSON.stringify(seedIds))
      this.log('log', `[sync] backfill stages skipped for seeded accounts ${seedIds.join(', ')}`)
    }

    this.test = input.testMode
      ? new TestOperations({
          db: this.db,
          testSeed: input.testSeed,
          userDataPath: input.userDataPath,
          activeAccountId: () => this.activeAccountId,
          activeSession: () => this.activeSession(),
          broadcastMailChanged: (accountId) => this.broadcastMailChanged(accountId),
          invalidateMailSummaries: (accountId) => {
            if (accountId === null) this.mailSummaryByAccount.clear()
            else this.mailSummaryByAccount.delete(accountId)
          }
        })
      : null

    this.handlers = createServiceHandlers({
      db: this.db,
      currentAccountId: () => this.activeAccountId,
      accountStatuses: () => this.accountStatuses(),
      mailboxCounts: (accountId) => this.mailboxCounts(accountId),
      splitState: (accountId) => this.accountSplitState(accountId),
      makeClient: () => this.makeClientForActive(),
      makeProvider: () => this.makeProviderForActive(),
      makeServerSearchProvider: () => this.makeCurrentServerSearchProvider(),
      activeSession: () => this.activeSession(),
      broadcastMailChanged: (serverSearchRequestId) =>
        this.broadcastMailChanged(this.activeAccountId, serverSearchRequestId),
      publishRemoteImagePolicy: () => this.emitRemoteImagePolicy(),
      broadcastOutboxChanged: (payload) => this.emit({ kind: 'outbox-changed', payload }),
      broadcastBodyHydrationFailed: (accountId, threadId) =>
        this.emit({ kind: 'body-hydration-failed', accountId, threadId }),
      trackForegroundProviderWork: (accountId, work) => this.trackForegroundProviderWork(accountId, work),
      peekRevertedActions: (accountId) => this.actionRevertNotices.peek(accountId),
      acknowledgeRevertedActions: (accountId, noticeId) =>
        this.actionRevertNotices.acknowledge(accountId, noticeId),
      ...(this.test ? { test: this.test } : {}),
      testUserData: input.testMode,
      userDataPath: input.userDataPath,
      downloadsPath: input.downloadsPath
    })

    for (const auth of input.accounts.accounts) this.createSession(auth.id, auth, false)
    for (const seedId of seedIds) this.createSession(seedId, null, true)
    this.desiredAccounts = new Map<string, ServiceAccountAuth | null>([
      ...input.accounts.accounts.map((auth): [string, ServiceAccountAuth | null] => [auth.id, auth]),
      ...seedIds.map((id): [string, ServiceAccountAuth | null] => [id, null])
    ])
    this.desiredActiveAccountId = input.accounts.activeAccountId
    this.activeAccountId = this.resolveActiveAccount(input.accounts.activeAccountId, 'initialize')
    this.persistActiveAccount()
  }

  ready(): ServiceReady {
    return {
      activeAccountId: this.activeAccountId,
      accountIds: [...this.accountOrder],
      schemaVersion: schemaVersion(this.db),
      background: {
        launchAtLogin: settingEnabled(this.db, 'launchAtLogin', true),
        loginItemRegistered: readSetting(this.db, 'loginItemRegistered') !== undefined,
        menuBarIcon: settingEnabled(this.db, 'menuBarIcon', false),
        unreadBadgeEnabled: settingEnabled(
          this.db,
          'unreadBadgeEnabled',
          APP_SETTINGS_DEFAULTS.unreadBadgeEnabled
        )
      }
    }
  }

  invoke(channel: InvokeChannel, args: unknown[]): Promise<unknown> {
    return this.handlers.invoke(channel, args)
  }

  async internal(operation: ServiceOperation, args: unknown[]): Promise<unknown> {
    if (operation === 'resume-auth-failures') {
      // Sign-in names the account it reauthenticated — which need not be the
      // active one, since adding an account no longer activates it (F18).
      const requested = args[0]
      const accountId = typeof requested === 'string' ? requested : this.activeAccountId
      const session = accountId ? (this.sessions.get(accountId) ?? null) : null
      if (!session) return 0
      const resumed = session.actionExecutor.resumeAuthFailures(session.id)
      if (resumed > 0) void session.syncController.resumeOnlineWork()
      return resumed
    }
    if (operation === 'apply-accounts') {
      const state = args[0]
      if (!isServiceAccountsState(state)) throw new Error('invalid accounts state')
      // Await deferred re-creates so the caller's answer names sessions that
      // actually exist — main publishes AuthStatus from this response.
      await Promise.all(this.applyAccounts(state))
      return this.activeAccountId
    }
    if (operation === 'set-active-account') {
      const accountId = args[0]
      if (typeof accountId !== 'string') throw new Error('unknown account')
      await this.test?.awaitSetActiveAccountDelay()
      // A just-re-added account can still be waiting out its predecessor's
      // worker retirement; the switch waits for the session instead of failing.
      const pending = this.pendingSessionCreations.get(accountId)
      if (pending && !this.sessions.has(accountId)) await pending
      if (!this.sessions.has(accountId)) throw new Error('unknown account')
      this.setActiveAccount(accountId)
      return this.activeAccountId
    }
    if (operation === 'remove-account-data') {
      const accountId = args[0]
      if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('unknown account')
      // The roster update precedes this call, so no session may exist; the
      // torn-down session's draft/outbox workers still get their quiesce
      // before the rows they might touch disappear (AGENTS shutdown rule).
      if (this.sessions.has(accountId)) throw new Error('account session still active')
      const retirement = this.retirements.get(accountId)
      const deletion = (async () => {
        await retirement
        if (this.sessions.has(accountId)) throw new Error('account session still active')
        // Keep the identifying rows until every directory is gone. A failed
        // deletion stays retryable and must never be reported as a successful purge.
        for (const outboxId of accountOutboxSpoolIds(this.db, accountId)) {
          await deleteOutboxSpool(this.input.userDataPath, outboxId)
        }
        const purged = purgeAccountRows(this.db, accountId)
        this.log(
          'log',
          `[accounts] deleted local data for ${accountId} (${purged.tables.length} tables, ${purged.outboxSpoolIds.length} spool entries)`
        )
        this.broadcastBadge()
      })()
      // A concurrent re-add and normal shutdown must wait for filesystem work
      // as well as worker retirement. The requesting caller still sees failures.
      const settled = deletion
        .catch(() => {})
        .finally(() => {
          if (this.retirements.get(accountId) === settled) this.retirements.delete(accountId)
        })
      this.retirements.set(accountId, settled)
      return deletion
    }
    if (operation === 'mark-login-item-registered') {
      writeSetting(this.db, 'loginItemRegistered', 'true')
      return undefined
    }
    if (operation === 'resolve-message-sender') {
      // The remote-image filter's sender lookup (T33): resolved from the
      // active account's store at frame registration, never from markup.
      const messageId = args[0]
      if (typeof messageId !== 'string' || !this.activeAccountId) return null
      return resolveMessageSender(this.db, this.activeAccountId, messageId)
    }
    if (operation === 'set-notification-pause') {
      const pausedUntil = args[0]
      if (pausedUntil !== null && (typeof pausedUntil !== 'number' || !Number.isFinite(pausedUntil))) {
        throw new Error('invalid notification pause')
      }
      setNotificationPausedUntil(this.db, pausedUntil)
      return undefined
    }
    if (operation === 'test') {
      if (!this.test) throw new Error('test operations are disabled')
      return this.test.handle(args[0], args.slice(1))
    }
    throw new Error(`unknown service operation: ${operation}`)
  }

  control(control: ServiceControl): void {
    if (control.kind === 'focus') {
      this.focused = control.focused
      return
    }
    if (control.kind === 'refresh-schedulers') {
      for (const session of this.sessions.values()) {
        session.snoozeScheduler.refresh()
        session.outboxSender.refresh()
      }
      return
    }
    if (control.kind === 'stop') void this.stop()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    historyEvents.off('newMail', this.onNewMail)
    this.handlers.stop()
    const workers: Promise<unknown>[] = [...this.retirements.values()]
    for (const session of this.sessions.values()) {
      session.readAbort.abort(new Error('account session stopped'))
      session.syncController.stop()
      session.actionExecutor.stop()
      session.snoozeScheduler.stop()
      workers.push(session.draftMirrorExecutor.stop(), session.outboxSender.stop())
    }
    const stopped = await Promise.allSettled(workers)
    for (const result of stopped) {
      if (result.status === 'rejected')
        this.log('error', `[shutdown] worker stop failed: ${String(result.reason)}`)
    }
    this.disposeGmailQuotaLimiters(new Error('utility shutting down'))
    this.actionRevertNotices.clear()
    this.db.close()
  }

  private async start(): Promise<void> {
    await reconcileOutboxSpool(this.db, this.input.userDataPath)
    historyEvents.on('newMail', this.onNewMail)
    this.schedulersStarted = true
    for (const session of this.sessions.values()) {
      session.snoozeScheduler.start()
      session.outboxSender.start()
    }
    this.broadcastBadge()
    // Seed main's request filter with the stored policy before any window
    // can mount a mail frame (T33).
    this.emitRemoteImagePolicy()
    for (const session of this.sessions.values()) void session.syncController.resumeOnlineWork()
  }

  private emitRemoteImagePolicy(): void {
    this.emit({ kind: 'remote-images', ...storedRemoteImagePolicy(this.db) })
  }

  private activeSession(): AccountSession | null {
    return this.activeAccountId ? (this.sessions.get(this.activeAccountId) ?? null) : null
  }

  private createSession(id: string, auth: ServiceAccountAuth | null, seeded: boolean): AccountSession {
    const actionExecutor = new ActionExecutor(
      this.db,
      () => (this.sessions.get(id) ? id : null),
      () => this.test?.actionProvider(id) ?? this.makeProviderFor(id),
      {
        notify: () => this.broadcastMailChanged(id),
        notifyReverted: (accountId, actions) => this.broadcastActionsReverted(accountId, actions)
      }
    )
    const draftMirrorExecutor = new DraftMirrorExecutor(
      this.db,
      () => (this.sessions.get(id) ? id : null),
      () => this.makeProviderFor(id),
      { spoolRoot: join(this.input.userDataPath, 'outbox') }
    )
    const outboxSender = new OutboxSender(
      this.db,
      () => (this.sessions.get(id) ? id : null),
      () => this.test?.outboxProvider(id) ?? this.makeProviderFor(id),
      (payload) => this.emitForAccount(id, { kind: 'outbox-changed', payload }),
      {
        beforeRemote: (signal) => draftMirrorExecutor.waitForIdle(signal),
        spoolRoot: join(this.input.userDataPath, 'outbox'),
        cleanSpool: (outboxId) => cleanOutboxSpool(this.input.userDataPath, outboxId),
        progress: (payload) => this.emitForAccount(id, { kind: 'outbox-progress', payload }),
        mailChanged: () => this.broadcastMailChanged(id),
        // A send with a follow-up created or settled its reminder: re-arm the
        // scheduler so the deadline (or its cancellation) takes effect (T35).
        followUpsChanged: () => this.sessions.get(id)?.snoozeScheduler.refresh()
      }
    )
    const snoozeScheduler = new SnoozeScheduler(
      this.db,
      () => (this.sessions.get(id) ? id : null),
      () => this.broadcastMailChanged(id),
      () => void actionExecutor.trigger()
    )
    const syncController = new SyncController({
      db: this.db,
      currentAccountId: () => (this.sessions.get(id) ? id : null),
      isSignedIn: () => this.sessions.has(id),
      isSeeded: () => seeded,
      makeProvider: () => this.makeProviderFor(id),
      // Inactive accounts always poll at the 60s background cadence (F18).
      isForeground: () => this.focused && this.activeAccountId === id,
      hasForegroundProviderWork: (accountId) =>
        this.foregroundProviderWork.size > 0 || this.otherAccountWorkBusy(accountId),
      mailRevision: () => this.mailRevision,
      broadcastState: (payload) => {
        this.emitForAccount(id, { kind: 'sync-state', payload })
        // Any account's phase change can flip its menu/chip readout.
        this.broadcastAccountStatuses()
      },
      broadcastMailChanged: (reason) => this.broadcastMailChanged(id, undefined, reason),
      getActionExecutor: () => actionExecutor,
      getDraftMirrorExecutor: () => draftMirrorExecutor,
      getOutboxSender: () => outboxSender,
      getSnoozeScheduler: () => snoozeScheduler,
      acquireIndexingSlot: (accountId) => this.indexingSlot.acquire(accountId),
      shouldPreemptIndexing: (accountId) => this.indexingSlot.hasPriorityWaiter(accountId),
      cleanOutboxSpool: (outboxId) => cleanOutboxSpool(this.input.userDataPath, outboxId)
    })
    const session: AccountSession = {
      id,
      auth,
      seeded,
      readAbort: new AbortController(),
      syncController,
      actionExecutor,
      draftMirrorExecutor,
      outboxSender,
      snoozeScheduler
    }
    this.sessions.set(id, session)
    this.accountOrder.push(id)
    if (!seeded) syncController.onSignIn()
    if (this.schedulersStarted) {
      snoozeScheduler.start()
      outboxSender.start()
      void syncController.resumeOnlineWork()
    }
    return session
  }

  private teardownSession(session: AccountSession): void {
    // Invalidate every Gmail read before purging or replacing this session.
    // Mutations keep their worker-owned grace period so returned draft ids
    // still become durable before those workers retire.
    session.readAbort.abort(new Error('account removed'))
    this.sessions.delete(session.id)
    const orderIndex = this.accountOrder.indexOf(session.id)
    if (orderIndex >= 0) this.accountOrder.splice(orderIndex, 1)
    session.syncController.stop()
    session.actionExecutor.stop()
    session.snoozeScheduler.stop()
    const retirement = Promise.allSettled([session.draftMirrorExecutor.stop(), session.outboxSender.stop()])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected')
            this.log('error', `[accounts] worker stop failed: ${String(result.reason)}`)
        }
      })
      .finally(() => {
        if (this.retirements.get(session.id) === retirement) this.retirements.delete(session.id)
      })
    this.retirements.set(session.id, retirement)
    const limiter = this.gmailQuotaLimiters.get(session.id)
    if (limiter) {
      limiter.dispose(new Error('account removed'))
      this.gmailQuotaLimiters.delete(session.id)
    }
    this.actionRevertNotices.clear(session.id)
    this.test?.forgetAccount(session.id)
    clearUndo(session.id)
  }

  /** Create the account's session now, or once its predecessor's workers retire. */
  private createSessionWhenRetired(id: string): Promise<void> {
    const retirement = this.retirements.get(id)
    if (!retirement) {
      const auth = this.desiredAccounts.get(id)
      if (auth !== undefined) this.createSession(id, auth, auth === null)
      return Promise.resolve()
    }
    let pending: Promise<void>
    pending = retirement
      .then(() => {
        if (this.stopped || this.sessions.has(id)) return
        // Re-check the latest intent: the roster may have changed again while
        // the predecessor quiesced, and only the newest wanted state counts.
        const auth = this.desiredAccounts.get(id)
        if (auth === undefined) return
        this.createSession(id, auth, auth === null)
        if (this.desiredActiveAccountId === id || this.activeAccountId === null) {
          this.setActiveAccount(this.resolveActiveAccount(this.desiredActiveAccountId, 'control'))
        }
        this.broadcastBadge()
      })
      .finally(() => {
        if (this.pendingSessionCreations.get(id) === pending) this.pendingSessionCreations.delete(id)
      })
    this.pendingSessionCreations.set(id, pending)
    return pending
  }

  /** Returns the deferred session creations so callers can await settlement. */
  private applyAccounts(state: ServiceAccountsState): Promise<void>[] {
    if (this.stopped) return []
    this.mailSummaryByAccount.clear()
    const pendingCreations: Promise<void>[] = []
    this.config = state.config
    const currentSeedIds = [
      ...new Set([
        ...[...this.sessions.values()].filter((session) => session.seeded).map((session) => session.id),
        ...[...this.desiredAccounts.entries()].filter(([, auth]) => auth === null).map(([id]) => id)
      ])
    ]
    const wantedSeedIds = this.input.testSeed ? (state.seedAccountIds ?? currentSeedIds) : []
    this.desiredAccounts = new Map<string, ServiceAccountAuth | null>([
      ...state.accounts.map((auth): [string, ServiceAccountAuth | null] => [auth.id, auth]),
      ...wantedSeedIds.map((id): [string, ServiceAccountAuth | null] => [id, null])
    ])
    // Keep the persisted seed roster in step so a removed-with-Keep account
    // stays dormant across relaunch (its rows survive in `accounts`).
    if (this.input.testSeed) writeSetting(this.db, 'seedAccountIds', JSON.stringify(wantedSeedIds))
    this.desiredActiveAccountId = state.activeAccountId
    for (const session of [...this.sessions.values()]) {
      if (!this.desiredAccounts.has(session.id)) this.teardownSession(session)
    }
    for (const auth of state.accounts) {
      const existing = this.sessions.get(auth.id)
      if (!existing) {
        pendingCreations.push(this.createSessionWhenRetired(auth.id))
        continue
      }
      const reauthenticated = existing.auth?.generation !== auth.generation
      existing.auth = auth
      if (reauthenticated) {
        existing.readAbort.abort(new Error('authentication changed'))
        existing.readAbort = new AbortController()
        // A fresh interactive sign-in replaces whatever a stuck client was
        // waiting on; new providers pick the new tokens up on creation.
        this.gmailQuotaLimiters.get(auth.id)?.dispose(new Error('authentication changed'))
        this.gmailQuotaLimiters.delete(auth.id)
        // Reset the session rather than resuming it: the history poller holds
        // the provider it was built with, so a resume would keep polling on
        // the replaced credentials until restart (SPEC F18 reconnect).
        existing.syncController.onSignIn()
      }
    }
    for (const seedId of wantedSeedIds) {
      if (!this.sessions.has(seedId)) pendingCreations.push(this.createSessionWhenRetired(seedId))
    }
    // Mirror the roster's switcher order for live sessions (F15 reorder):
    // sessions are keyed by id and never restarted by an order change, but
    // the status broadcasts and `ready()` walk `accountOrder`. Ids without a
    // session yet keep their creation-time append; the next roster push
    // re-sorts them once they exist.
    const desiredOrder = [...this.desiredAccounts.keys()]
    this.accountOrder.sort((left, right) => desiredOrder.indexOf(left) - desiredOrder.indexOf(right))
    const nextActive = this.resolveActiveAccount(state.activeAccountId, 'control')
    if (nextActive !== this.activeAccountId) this.setActiveAccount(nextActive, { force: true })
    else this.persistActiveAccount()
    this.broadcastBadge()
    return pendingCreations
  }

  /**
   * `initialize` prefers the persisted choice — main's snapshot may predate the
   * last switch — while a `control` payload is the newer intent and wins.
   */
  private resolveActiveAccount(requested: string | null, source: 'initialize' | 'control'): string | null {
    const valid = (candidate: string | null | undefined): string | null =>
      candidate && this.sessions.has(candidate) ? candidate : null
    const persisted = valid(readSetting(this.db, ACTIVE_ACCOUNT_SETTING))
    const fallback = this.accountOrder.length > 0 ? (this.accountOrder[0] ?? null) : null
    if (source === 'initialize') return persisted ?? valid(requested) ?? fallback
    return valid(requested) ?? valid(this.activeAccountId) ?? persisted ?? fallback
  }

  private setActiveAccount(accountId: string | null, options: { force?: boolean } = {}): void {
    if (!options.force && accountId === this.activeAccountId) return
    this.activeAccountId = accountId
    this.persistActiveAccount()
    const session = this.activeSession()
    // The footer must describe the account now on screen, immediately.
    this.emit({ kind: 'sync-state', payload: session?.syncController.getState() ?? { phase: 'idle' } })
    this.broadcastBadge()
    if (session) {
      void session.actionExecutor.trigger()
      void session.draftMirrorExecutor.trigger()
      void session.outboxSender.trigger()
    }
  }

  private persistActiveAccount(): void {
    // This setting does not change mail membership or split counts. Carry only
    // summaries that were current before the synchronous write across it;
    // an earlier silent mail write must still invalidate an older summary.
    const before = this.databaseRevision()
    if (this.activeAccountId) writeSetting(this.db, ACTIVE_ACCOUNT_SETTING, this.activeAccountId)
    else deleteSetting(this.db, ACTIVE_ACCOUNT_SETTING)
    const after = this.databaseRevision()
    for (const summary of this.mailSummaryByAccount.values()) {
      if (summary.revision === before) summary.revision = after
    }
  }

  private otherAccountWorkBusy(accountId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.id === accountId) continue
      if (
        session.actionExecutor.isRunning() ||
        session.draftMirrorExecutor.isRunning() ||
        session.outboxSender.isRunning()
      ) {
        return true
      }
    }
    return false
  }

  private makeClientFor(id: string): GmailClient | null {
    const session = this.sessions.get(id)
    const auth = session?.auth
    if (!session || !auth || !this.config) return null
    let quotaLimiter = this.gmailQuotaLimiters.get(id)
    if (!quotaLimiter) {
      quotaLimiter = new GmailQuotaLimiter({
        unitsPerMinute: this.config.quota_units_per_minute ?? DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE
      })
      this.gmailQuotaLimiters.set(id, quotaLimiter)
    }
    return new GmailClient(
      this.config,
      auth.tokens,
      (tokens) => {
        // Stale after removal or a newer interactive sign-in of this account.
        // The generation is what identifies the credentials: `applyAccounts`
        // assigns a fresh auth object on every roster push, so an
        // object-identity check silently stopped persisting refreshes for
        // long-lived clients such as the poller's (B31).
        const currentAuth = this.sessions.get(id) === session ? session.auth : null
        if (!currentAuth || currentAuth.generation !== auth.generation) return
        session.auth = { ...currentAuth, tokens }
        this.emit({ kind: 'token-update', accountId: id, tokens, generation: auth.generation })
      },
      { quotaLimiter, readSignal: session.readAbort.signal }
    )
  }

  private makeClientForActive(): GmailClient | null {
    return this.activeAccountId ? this.makeClientFor(this.activeAccountId) : null
  }

  private makeProviderFor(id: string): GmailMailProvider | null {
    if (this.sessions.get(id)?.seeded) return null
    const client = this.makeClientFor(id)
    return client ? new GmailMailProvider(client) : null
  }

  private makeProviderForActive(): GmailMailProvider | null {
    return this.activeAccountId ? this.makeProviderFor(this.activeAccountId) : null
  }

  private makeCurrentServerSearchProvider(): ServerSearchProvider | null {
    const session = this.activeSession()
    if (session?.seeded && this.input.testSeed) {
      const seedPath = this.input.testSeed
      const accountId = session.id
      return {
        listThreadIds: async (options = {}) => ({
          threadIds: readSeedRemoteThreadIds(seedPath, options.q ?? '', accountId)
        }),
        getThread: async (threadId) => {
          const thread = readSeedThread(seedPath, threadId, Date.now(), accountId)
          if (!thread) throw new GmailApiError(404, 'seed thread unavailable')
          return thread
        },
        getAttachmentData: async () => undefined,
        quotaMetrics: () => ({ requests: 0, units: 0, waitMs: 0 })
      }
    }
    return this.makeProviderForActive()
  }

  private disposeGmailQuotaLimiters(reason: Error): void {
    for (const limiter of this.gmailQuotaLimiters.values()) limiter.dispose(reason)
    this.gmailQuotaLimiters.clear()
  }

  private async trackForegroundProviderWork<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    this.foregroundProviderWork.set(accountId, (this.foregroundProviderWork.get(accountId) ?? 0) + 1)
    this.mailSummaryByAccount.delete(accountId)
    try {
      return await work()
    } finally {
      const remaining = (this.foregroundProviderWork.get(accountId) ?? 1) - 1
      if (remaining > 0) this.foregroundProviderWork.set(accountId, remaining)
      else this.foregroundProviderWork.delete(accountId)
      // Provider reads can persist partial results without a renderer event
      // when the user switches accounts before the request settles.
      this.mailSummaryByAccount.delete(accountId)
    }
  }

  /** Renderer-facing events describe the active account only; others are noise there. */
  private emitForAccount(accountId: string, event: ServiceEvent): void {
    if (accountId !== this.activeAccountId) return
    this.emit(event)
  }

  private broadcastMailChanged(
    accountId: string | null,
    serverSearchRequestId?: string,
    reason?: MailChangeReason
  ): void {
    this.mailRevision += 1
    if (accountId === null) this.mailSummaryByAccount.clear()
    else this.mailSummaryByAccount.delete(accountId)
    if (accountId === null || accountId === this.activeAccountId) {
      this.emit({
        kind: 'mail-changed',
        ...(serverSearchRequestId ? { serverSearchRequestId } : {}),
        ...(reason ? { reason } : {})
      })
    }
    this.broadcastBadge()
  }

  /**
   * Reuse per-account summaries between writes on this SQLite connection.
   * Background passes can commit without broadcasting a mail change. Only the
   * known mail-independent account-selection write preserves current summaries.
   */
  private mailSummary(accountId: string): AccountMailSummary {
    if (this.foregroundProviderWork.has(accountId)) return { revision: -1 }
    const revision = this.databaseRevision()
    const cached = this.mailSummaryByAccount.get(accountId)
    if (cached && cached.revision === revision) return cached
    const summary: AccountMailSummary = { revision }
    this.mailSummaryByAccount.set(accountId, summary)
    return summary
  }

  private databaseRevision(): number {
    return (this.db.prepare('SELECT total_changes() AS revision').get() as { revision: number }).revision
  }

  private mailboxCounts(accountId: string): SystemMailboxCounts {
    const summary = this.mailSummary(accountId)
    summary.mailboxCounts ??= countSystemMailboxes(this.db, accountId)
    return summary.mailboxCounts
  }

  private accountSplitState(accountId: string): SplitState {
    const summary = this.mailSummary(accountId)
    summary.splitState ??= getSplitState(this.db, accountId)
    return summary.splitState
  }

  private accountUnread(accountId: string): number {
    const legacySeed = this.input.testMode && !hasSplitSetup(this.db, accountId)
    return legacySeed
      ? countInboxUnread(this.db, accountId)
      : this.accountSplitState(accountId).splits.reduce(
          (sum, split) => sum + (split.notify ? split.unread : 0),
          0
        )
  }

  /**
   * The account menu's per-account readout: sync phase, reconnect need, and
   * unread, for every session in switcher order — a background account's
   * failure must be discoverable without switching to it (F18).
   */
  private accountStatuses(): AccountSyncStatus[] {
    return this.accountOrder.flatMap((accountId) => {
      const session = this.sessions.get(accountId)
      if (!session) return []
      return [
        {
          accountId,
          phase: accountSyncPhase(
            session.syncController.getState(),
            actionQueueStatus(this.db, accountId).authPaused
          ),
          unread: this.accountUnread(accountId)
        }
      ]
    })
  }

  private broadcastBadge(): void {
    let unreadCount = 0
    for (const session of this.sessions.values()) unreadCount += this.accountUnread(session.id)
    this.emit({ kind: 'badge', unreadCount })
    this.broadcastAccountStatuses()
  }

  /**
   * Push the roster's health when a *phase* moves: a background account's
   * Reconnect/Offline must reach the account chip live, not only when the
   * menu next opens (F18). Deliberately keyed on phases alone — they are
   * cheap to read (controller state plus a tiny action_queue scan), while the
   * per-account unread counts are aggregate queries that must not run on
   * every mail-change; the menu re-reads full statuses when it opens.
   */
  private broadcastAccountStatuses(): void {
    const fingerprint = JSON.stringify(
      this.accountOrder.map((accountId) => {
        const session = this.sessions.get(accountId)
        if (!session) return [accountId, null]
        return [
          accountId,
          accountSyncPhase(
            session.syncController.getState(),
            actionQueueStatus(this.db, accountId).authPaused
          )
        ]
      })
    )
    if (fingerprint === this.lastAccountStatuses) return
    this.lastAccountStatuses = fingerprint
    this.emit({ kind: 'accounts-status', statuses: this.accountStatuses() })
  }

  private broadcastActionsReverted(accountId: string, actions: RevertedAction[]): void {
    this.actionRevertNotices.add(accountId, actions)
    this.emit({ kind: 'actions-reverted', accountId, actions })
  }

  private log(level: 'log' | 'warn' | 'error', message: string): void {
    this.emit({ kind: 'log', level, message })
  }
}

function isServiceAccountsState(value: unknown): value is ServiceAccountsState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<ServiceAccountsState>
  return (
    Array.isArray(state.accounts) &&
    (state.activeAccountId === null || typeof state.activeAccountId === 'string') &&
    (state.seedAccountIds === undefined || Array.isArray(state.seedAccountIds))
  )
}
