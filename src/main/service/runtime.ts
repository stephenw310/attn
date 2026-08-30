import { join } from 'node:path'
import type { RevertedAction } from '../../shared/actionRevert'
import { type InvokeChannel, type MailChangeReason, TEST_CHANNELS } from '../../shared/ipc'
import type { MessageMailbox, SyncState } from '../../shared/mail'
import { ALLOWED_UNDO_SEND_SECONDS } from '../../shared/outboxTuning'
import { clearUndo } from '../actions'
import { ActionExecutor, type ActionRecoveryProvider } from '../actions/executor'
import { ActionRevertNotices } from '../actions/revertNotices'
import { type Db, openDatabase, schemaVersion } from '../db'
import { countInboxUnread, listMailboxThreads } from '../db/queries'
import { loadSeed, readSeedRemoteThreadIds, readSeedThread } from '../dev/seed'
import { GmailApiError, GmailClient } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { GmailMailProvider } from '../gmail/provider'
import { GmailQuotaLimiter } from '../gmail/quota'
import { reconcileRemoteDraft } from '../outbox/draftSync'
import { DraftMirrorExecutor } from '../outbox/mirrorExecutor'
import { cachePrimarySendAs } from '../outbox/sendAs'
import { OutboxSender } from '../outbox/sender'
import { cleanOutboxSpool, reconcileOutboxSpool } from '../outbox/spool'
import { SnoozeScheduler } from '../scheduler'
import { deleteSetting, readSetting, settingEnabled, writeSetting } from '../settings'
import { countNotificationEnabledUnread, hasSplitSetup } from '../splits'
import { reconcileThreadExistence } from '../sync/existenceSweep'
import { refreshMessageBodyFromStore, removeAccountFromIndex, searchMessageIndex } from '../sync/fts'
import { runFtsBackfill } from '../sync/ftsBackfill'
import { runLifetimeSweep } from '../sync/lifetimeSweep'
import { deleteThread, type LabelRow } from '../sync/persist'
import { historyEvents, type NewMail } from '../sync/poller'
import type { MailProvider } from '../sync/provider'
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

export type ServiceEventSink = (event: ServiceEvent) => void

const ACTIVE_ACCOUNT_SETTING = 'activeAccountId'

/**
 * One signed-in account's live machinery (F18). Every worker is bound to this
 * account through its `accountId()` callback, so the executor classes stay
 * exactly as single-account as they were — the runtime holds one set per
 * account instead of one total.
 */
interface AccountSession {
  readonly id: string
  /** Null for seeded e2e accounts, which never talk to Gmail. */
  auth: ServiceAccountAuth | null
  readonly seeded: boolean
  readonly syncController: SyncController
  readonly actionExecutor: ActionExecutor
  readonly draftMirrorExecutor: DraftMirrorExecutor
  readonly outboxSender: OutboxSender
  readonly snoozeScheduler: SnoozeScheduler
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
  private searchWindowOverride: number | null = null
  private draftSaveFailures = 0
  private conversationDelay: { threadId: string; delayMs: number } | null = null
  private draftReopenDelayMs = 0
  private draftInlineImageDelayMs = 0
  private setActiveAccountDelayMs = 0
  private actionProvider: ActionRecoveryProvider | null = null

  private readonly onNewMail = (accountId: string, newMail: NewMail[]): void => {
    // Notification routing for inactive accounts is A4 scope; until then only
    // the active account's poll cycles surface candidates.
    if (accountId !== this.activeAccountId || !this.sessions.has(accountId)) return
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
      seedIds =
        existing.length > 0 ? existing.map((row) => row.id) : loadSeed(this.db, input.testSeed).accountIds
      this.log('log', `[sync] backfill stages skipped for seeded accounts ${seedIds.join(', ')}`)
    }

    this.handlers = createServiceHandlers({
      db: this.db,
      currentAccountId: () => this.activeAccountId,
      makeClient: () => this.makeClientForActive(),
      makeProvider: () => this.makeProviderForActive(),
      makeServerSearchProvider: () => this.makeCurrentServerSearchProvider(),
      isSeeded: () => this.activeSession()?.seeded ?? false,
      executor: () => this.activeSession()?.actionExecutor ?? null,
      draftMirrorExecutor: () => this.activeSession()?.draftMirrorExecutor ?? null,
      outboxSender: () => this.activeSession()?.outboxSender ?? null,
      scheduler: () => this.activeSession()?.snoozeScheduler ?? null,
      syncController: () => this.activeSession()?.syncController ?? null,
      broadcastMailChanged: (serverSearchRequestId) =>
        this.broadcastMailChanged(this.activeAccountId, serverSearchRequestId),
      broadcastOutboxChanged: (payload) => this.emit({ kind: 'outbox-changed', payload }),
      broadcastBodyHydrationFailed: (accountId, threadId) =>
        this.emit({ kind: 'body-hydration-failed', accountId, threadId }),
      trackForegroundProviderWork: (accountId, work) => this.trackForegroundProviderWork(accountId, work),
      peekRevertedActions: (accountId) => this.actionRevertNotices.peek(accountId),
      acknowledgeRevertedActions: (accountId, noticeId) =>
        this.actionRevertNotices.acknowledge(accountId, noticeId),
      waitForConversation: (threadId) => this.waitForConversation(threadId),
      draftReopenDelay: () => this.draftReopenDelayMs,
      draftInlineImageDelay: () => this.draftInlineImageDelayMs,
      consumeTestDraftSaveFailure: () => this.consumeDraftSaveFailure(),
      mailRevision: () => this.mailRevision,
      searchWindowOverride: () => this.searchWindowOverride,
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
        loginItemRegistered: readSetting(this.db, 'loginItemRegistered') !== undefined
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
      if (this.input.testMode && this.setActiveAccountDelayMs > 0) {
        // One-shot e2e seam modeling the retirement wait below without
        // needing a real mid-quiesce account.
        const delayMs = this.setActiveAccountDelayMs
        this.setActiveAccountDelayMs = 0
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      // A just-re-added account can still be waiting out its predecessor's
      // worker retirement; the switch waits for the session instead of failing.
      const pending = this.pendingSessionCreations.get(accountId)
      if (pending && !this.sessions.has(accountId)) await pending
      if (!this.sessions.has(accountId)) throw new Error('unknown account')
      this.setActiveAccount(accountId)
      return this.activeAccountId
    }
    if (operation === 'mark-login-item-registered') {
      writeSetting(this.db, 'loginItemRegistered', 'true')
      return undefined
    }
    if (operation === 'set-notification-pause') {
      const pausedUntil = args[0]
      if (pausedUntil !== null && (typeof pausedUntil !== 'number' || !Number.isFinite(pausedUntil))) {
        throw new Error('invalid notification pause')
      }
      setNotificationPausedUntil(this.db, pausedUntil)
      return undefined
    }
    if (operation === 'test') return this.handleTest(args[0], args.slice(1))
    throw new Error(`unknown service operation: ${operation}`)
  }

  control(control: ServiceControl): void {
    if (control.kind === 'accounts') {
      void this.applyAccounts(control.accounts)
      return
    }
    if (control.kind === 'focus') {
      this.focused = control.focused
      return
    }
    if (control.kind === 'resume') {
      for (const session of this.sessions.values()) void session.syncController.resumeOnlineWork()
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
    for (const session of this.sessions.values()) void session.syncController.resumeOnlineWork()
  }

  private activeSession(): AccountSession | null {
    return this.activeAccountId ? (this.sessions.get(this.activeAccountId) ?? null) : null
  }

  private createSession(id: string, auth: ServiceAccountAuth | null, seeded: boolean): AccountSession {
    const actionExecutor = new ActionExecutor(
      this.db,
      () => (this.sessions.get(id) ? id : null),
      () => (id === this.activeAccountId ? this.actionProvider : null) ?? this.makeProviderFor(id),
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
      () => this.makeProviderFor(id),
      (payload) => this.emitForAccount(id, { kind: 'outbox-changed', payload }),
      {
        beforeRemote: (signal) => draftMirrorExecutor.waitForIdle(signal),
        spoolRoot: join(this.input.userDataPath, 'outbox'),
        cleanSpool: (outboxId) => cleanOutboxSpool(this.input.userDataPath, outboxId),
        progress: (payload) => this.emitForAccount(id, { kind: 'outbox-progress', payload }),
        mailChanged: () => this.broadcastMailChanged(id)
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
      broadcastState: (payload) => this.emitForAccount(id, { kind: 'sync-state', payload }),
      broadcastMailChanged: (reason) => this.broadcastMailChanged(id, undefined, reason),
      getActionExecutor: () => actionExecutor,
      getDraftMirrorExecutor: () => draftMirrorExecutor,
      getOutboxSender: () => outboxSender,
      getSnoozeScheduler: () => snoozeScheduler,
      acquireIndexingSlot: (accountId) => this.indexingSlot.acquire(accountId)
    })
    const session: AccountSession = {
      id,
      auth,
      seeded,
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
    if (this.activeAccountId) writeSetting(this.db, ACTIVE_ACCOUNT_SETTING, this.activeAccountId)
    else deleteSetting(this.db, ACTIVE_ACCOUNT_SETTING)
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
        if (this.sessions.get(id) !== session || session.auth !== auth) return
        session.auth = { ...auth, tokens }
        this.emit({ kind: 'token-update', accountId: id, tokens, generation: auth.generation })
      },
      { quotaLimiter }
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
    try {
      return await work()
    } finally {
      const remaining = (this.foregroundProviderWork.get(accountId) ?? 1) - 1
      if (remaining > 0) this.foregroundProviderWork.set(accountId, remaining)
      else this.foregroundProviderWork.delete(accountId)
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
    if (accountId === null || accountId === this.activeAccountId) {
      this.emit({
        kind: 'mail-changed',
        ...(serverSearchRequestId ? { serverSearchRequestId } : {}),
        ...(reason ? { reason } : {})
      })
    }
    this.broadcastBadge()
  }

  private broadcastBadge(): void {
    let unreadCount = 0
    for (const session of this.sessions.values()) {
      const legacySeed = this.input.testMode && !hasSplitSetup(this.db, session.id)
      unreadCount += legacySeed
        ? countInboxUnread(this.db, session.id)
        : countNotificationEnabledUnread(this.db, session.id)
    }
    this.emit({ kind: 'badge', unreadCount })
  }

  private broadcastActionsReverted(accountId: string, actions: RevertedAction[]): void {
    this.actionRevertNotices.add(accountId, actions)
    this.emit({ kind: 'actions-reverted', accountId, actions })
  }

  private async waitForConversation(threadId: string): Promise<void> {
    const delay = this.conversationDelay
    if (delay?.threadId === threadId) await new Promise((resolve) => setTimeout(resolve, delay.delayMs))
  }

  private consumeDraftSaveFailure(): boolean {
    if (this.draftSaveFailures === 0) return false
    this.draftSaveFailures--
    return true
  }

  private async handleTest(channel: unknown, args: unknown[]): Promise<unknown> {
    if (typeof channel !== 'string') throw new Error('invalid test channel')
    if (!this.input.testMode) throw new Error('test operations are disabled')
    const accountId = this.activeAccountId
    if (channel === TEST_CHANNELS.setSyncState) {
      this.activeSession()?.syncController.setStateForTest(args[0] as SyncState)
      return undefined
    }
    if (channel === TEST_CHANNELS.reloadSeed) {
      if (!this.input.testSeed) throw new Error('seed store unavailable')
      const labels = args[0]
      if (labels !== undefined && !isLabelRows(labels)) throw new Error('invalid authoritative label catalog')
      const result = loadSeed(this.db, this.input.testSeed, labels === undefined ? {} : { labels })
      if (result.labelsChanged) this.broadcastMailChanged(this.activeAccountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.deleteThread) {
      if (!accountId || typeof args[0] !== 'string') throw new Error('invalid thread delete')
      deleteThread(this.db, accountId, args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.delayConversation) {
      const [threadId, delayMs] = args
      if (typeof threadId === 'string' && typeof delayMs === 'number' && delayMs >= 0) {
        this.conversationDelay = { threadId, delayMs }
      }
      return undefined
    }
    if (channel === TEST_CHANNELS.delayDraftReopen) {
      this.draftReopenDelayMs = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.delayDraftInlineImage) {
      this.draftInlineImageDelayMs = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.delaySetActiveAccount) {
      this.setActiveAccountDelayMs = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.updateMessageBody) {
      const [messageId, bodyText] = args
      if (!accountId || typeof messageId !== 'string' || typeof bodyText !== 'string') {
        throw new Error('invalid message update')
      }
      this.db.transaction(() => {
        this.db
          .prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?')
          .run(bodyText, accountId, messageId)
        // Keep the seam on the production invariant: body and index move together.
        refreshMessageBodyFromStore(this.db, accountId, messageId)
      })()
      this.broadcastMailChanged(this.activeAccountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.setSendAsSignature) {
      const signature = args[0]
      if (!accountId || typeof signature !== 'string') throw new Error('invalid send-as signature')
      cachePrimarySendAs(this.db, accountId, {
        sendAsEmail: accountId,
        signature,
        isPrimary: true,
        isDefault: true
      })
      return undefined
    }
    if (channel === TEST_CHANNELS.failNextDraftSave) {
      this.draftSaveFailures++
      return undefined
    }
    if (channel === TEST_CHANNELS.markDraftMirrored) {
      const [draftId, gmailDraftId] = args
      if (!accountId || typeof draftId !== 'string') throw new Error('invalid mirrored draft update')
      this.db
        .prepare(
          `UPDATE outbox SET mirror_revision = local_revision,
         gmail_draft_id = COALESCE(?, gmail_draft_id)
         WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')`
        )
        .run(typeof gmailDraftId === 'string' ? gmailDraftId : null, accountId, draftId)
      return undefined
    }
    if (channel === TEST_CHANNELS.failNextAction || channel === TEST_CHANNELS.failNextActionAuth) {
      this.installActionFailure(args[0], channel === TEST_CHANNELS.failNextAction ? 400 : 401)
      return undefined
    }
    if (channel === TEST_CHANNELS.setUndoSendDelay) {
      const seconds = args[0]
      if (typeof seconds === 'number' && ALLOWED_UNDO_SEND_SECONDS.has(seconds)) {
        writeSetting(this.db, 'undoSendDelaySeconds', String(seconds))
      }
      return undefined
    }
    if (channel === TEST_CHANNELS.failOutbox) {
      const [id, message] = args
      if (!accountId || typeof id !== 'string' || typeof message !== 'string') {
        throw new Error('invalid outbox failure')
      }
      const result = this.db
        .prepare(
          `UPDATE outbox SET state = 'failed', send_at = NULL, last_error = ?
           WHERE account_id = ? AND id = ? AND state = 'queued'`
        )
        .run(message, accountId, id)
      if (result.changes === 0) throw new Error('queued message unavailable')
      return undefined
    }
    if (channel === TEST_CHANNELS.remoteDraft) {
      const remote = args[0]
      if (!accountId || !remote || typeof remote !== 'object') throw new Error('invalid remote draft')
      await reconcileRemoteDraft(this.db, accountId, remote as Parameters<typeof reconcileRemoteDraft>[2])
      this.broadcastMailChanged(this.activeAccountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.listMailboxThreadIds) {
      const mailbox = args[0]
      if (!accountId || !isMessageMailbox(mailbox)) throw new Error('mailbox query unavailable')
      const view = mailbox === 'all-mail' ? 'allMail' : mailbox
      return listMailboxThreads(this.db, accountId, view).map((row) => row.id)
    }
    if (channel === TEST_CHANNELS.runLifetimeSweep) return this.runTestLifetimeSweep(args[0])
    if (channel === TEST_CHANNELS.runExistenceSweep) return this.runTestExistenceSweep(args[0])
    if (channel === TEST_CHANNELS.runFtsBackfill) return this.runTestFtsBackfill(args[0])
    if (channel === TEST_CHANNELS.searchIndexStats) return this.testSearchIndexStats(args[0])
    if (channel === TEST_CHANNELS.setSearchWindow) {
      // The partial marker only appears once a search fills its recency window,
      // which a seeded store is far too small to do at the production size.
      const limit = args[0]
      this.searchWindowOverride = typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : null
      return undefined
    }
    if (channel === TEST_CHANNELS.utilityState) {
      const ids = args[0]
      if (!accountId || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw new Error('invalid utility state request')
      }
      const placeholders = ids.map(() => '?').join(', ')
      const threadCount = ids.length
        ? (
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM threads WHERE account_id = ? AND id IN (${placeholders})`
              )
              .get(accountId, ...ids) as { count: number }
          ).count
        : 0
      const messageCount = ids.length
        ? (
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND thread_id IN (${placeholders})`
              )
              .get(accountId, ...ids) as { count: number }
          ).count
        : 0
      const cursors = this.db
        .prepare(
          `SELECT backfill_cursor, sweep_cursor, attachment_cursor, split_metadata_cursor, fts_cursor
           FROM sync_state WHERE account_id = ?`
        )
        .get(accountId)
      const memory = process.memoryUsage()
      const cacheSize = this.db.pragma('cache_size', { simple: true }) as number
      const pageSize = this.db.pragma('page_size', { simple: true }) as number
      const sqliteCacheBudgetKb = cacheSize < 0 ? -cacheSize : (cacheSize * pageSize) / 1024
      return {
        threadCount,
        messageCount,
        cursors,
        utilityMemoryKb: {
          rss: memory.rss / 1024,
          heapTotal: memory.heapTotal / 1024,
          heapUsed: memory.heapUsed / 1024,
          external: memory.external / 1024,
          sqliteCacheBudget: sqliteCacheBudgetKb
        }
      }
    }
    throw new Error(`test operation is not implemented: ${channel}`)
  }

  private installActionFailure(threadId: unknown, status: 400 | 401): void {
    if (!this.input.testSeed || typeof threadId !== 'string') return
    const snapshot = readSeedThread(this.input.testSeed, threadId)
    if (!snapshot) return
    let rejectTarget = true
    const mutate = async (requestedThreadId: string): Promise<void> => {
      if (requestedThreadId !== threadId) return
      if (!rejectTarget) {
        if (status === 401) this.actionProvider = null
        return
      }
      rejectTarget = false
      const reason = status === 401 ? 'authentication e2e failure' : 'permanent e2e failure'
      throw new GmailApiError(status, `gmail /threads/${threadId}/modify failed (${status}): ${reason}`)
    }
    this.actionProvider = {
      modifyThread: mutate,
      trashThread: mutate,
      untrashThread: mutate,
      getThread: async (requestedThreadId) => {
        const requested = readSeedThread(this.input.testSeed as string, requestedThreadId)
        if (!requested) throw new GmailApiError(404, 'seed thread unavailable')
        if (requestedThreadId === threadId) this.actionProvider = null
        return requested
      }
    }
  }

  private async runTestLifetimeSweep(value: unknown): Promise<unknown> {
    const accountId = this.activeAccountId
    if (!accountId || !isLifetimeSweepRequest(value)) throw new Error('invalid lifetime sweep request')
    if (value.resetCursor) {
      this.db
        .prepare(
          `UPDATE sync_state
         SET sweep_cursor = ?, sweep_threads_done = 0, sweep_threads_total = NULL
         WHERE account_id = ?`
        )
        .run(value.resetCursor, accountId)
    }
    const threads = new Map(value.threads.map((thread) => [thread.id, thread]))
    const formats: string[] = []
    const pageTokens: Array<string | undefined> = []
    let failure: unknown
    const provider = {
      getProfile: async () => ({
        emailAddress: accountId,
        historyId: 'test-history',
        threadsTotal: value.threadsTotal,
        messagesTotal: value.messagesTotal
      }),
      listThreadIds: async (options = {}) => {
        pageTokens.push(options.pageToken)
        if (value.pauseAtPageToken !== undefined && options.pageToken === value.pauseAtPageToken) {
          await new Promise<never>(() => {})
        }
        if (value.offlineAtPageToken !== undefined && options.pageToken === value.offlineAtPageToken) {
          throw new Error('offline')
        }
        return value.pages.find((candidate) => candidate.pageToken === options.pageToken) ?? { threadIds: [] }
      },
      getThread: async (id: string, options = {}) => {
        formats.push(options.format ?? 'full')
        const thread = threads.get(id)
        if (!thread) throw new Error(`missing test thread ${id}`)
        return thread
      }
    } as MailProvider
    await runLifetimeSweep(
      this.db,
      provider,
      accountId,
      {
        onProgress: () => {},
        onError: (error) => {
          failure = error
        }
      },
      { requestIntervalMs: 0, pagePauseMs: 0, threadCap: value.threadCap }
    )
    const state = this.db
      .prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { sweep_cursor: string | null } | undefined
    return {
      cursor: state?.sweep_cursor ?? null,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
      formats,
      pageTokens
    }
  }

  private async runTestFtsBackfill(value: unknown): Promise<unknown> {
    const accountId = this.activeAccountId
    if (!accountId || !isFtsBackfillRequest(value)) throw new Error('invalid FTS backfill request')
    if (value.resetIndex) {
      // Reproduce the manual revision-18 upgrade state: stored messages with an
      // empty index and an unset cursor.
      this.db.transaction(() => {
        removeAccountFromIndex(this.db, accountId)
        this.db.prepare('UPDATE sync_state SET fts_cursor = NULL WHERE account_id = ?').run(accountId)
      })()
    }
    let failure: unknown
    const result = await runFtsBackfill(
      this.db,
      accountId,
      {
        onProgress: () => {},
        onError: (error) => {
          failure = error
        }
      },
      {
        batchPauseMs: 0,
        ...(value.batchSize === undefined ? {} : { batchSize: value.batchSize }),
        ...(value.pauseAfterBatches === undefined
          ? {}
          : {
              onBatchCheckpoint: ({ batchIndex }) =>
                batchIndex + 1 >= (value.pauseAfterBatches as number)
                  ? new Promise<never>(() => {})
                  : undefined
            })
      }
    )
    const state = this.db.prepare('SELECT fts_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
      | { fts_cursor: string | null }
      | undefined
    const parity = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE account_id = ?) AS messages,
           (SELECT COUNT(*) FROM message_fts_map WHERE account_id = ?) AS mapped,
           (SELECT COUNT(*) FROM message_fts) AS ftsRows`
      )
      .get(accountId, accountId)
    return {
      cursor: state?.fts_cursor ?? null,
      indexed: result?.messagesIndexed ?? null,
      parity,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {})
    }
  }

  private testSearchIndexStats(value: unknown): unknown {
    const accountId = this.activeAccountId
    if (!accountId || !isSearchIndexStatsRequest(value)) throw new Error('invalid search stats request')
    const runsPerQuery = value.runsPerQuery ?? 1
    const limit = value.limit ?? 50
    const queries = value.queries.map((match) => {
      const samplesUs: number[] = []
      let threadCount = 0
      for (let run = 0; run < runsPerQuery; run++) {
        const startedAt = process.hrtime.bigint()
        threadCount = searchMessageIndex(this.db, accountId, match, limit).length
        samplesUs.push(Number(process.hrtime.bigint() - startedAt) / 1_000)
      }
      return { match, threadCount, samplesUs }
    })
    const indexBytes = (
      this.db
        .prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE '%message_fts%'")
        .get() as { bytes: number }
    ).bytes
    return { indexBytes, queries }
  }

  private async runTestExistenceSweep(value: unknown): Promise<unknown> {
    const accountId = this.activeAccountId
    if (!accountId || !isExistenceSweepRequest(value)) throw new Error('invalid existence sweep request')
    const provider: Pick<MailProvider, 'listThreadIds' | 'getThread'> = {
      listThreadIds: async (options = {}) => {
        if (options.labelIds?.includes('SPAM')) return { threadIds: value.spamThreadIds }
        if (options.labelIds?.includes('TRASH')) return { threadIds: value.trashThreadIds }
        return { threadIds: value.allMailThreadIds }
      },
      getThread: async () => {
        // This seam receives complete authoritative id sets. A local row
        // absent from their union models a server-purged thread.
        throw new GmailApiError(404, 'test existence sweep thread missing')
      }
    }
    const result = await reconcileThreadExistence(this.db, accountId, provider)
    if (result?.deletedThreadIds.length) this.broadcastMailChanged(this.activeAccountId)
    return result
  }

  private log(level: 'log' | 'warn' | 'error', message: string): void {
    this.emit({ kind: 'log', level, message })
  }
}

interface LifetimeSweepRequest {
  resetCursor?: string
  threadCap?: number
  threads: GmailThread[]
  pages: Array<{
    pageToken?: string
    threadIds: string[]
    nextPageToken?: string
    resultSizeEstimate?: number
  }>
  offlineAtPageToken?: string
  pauseAtPageToken?: string
  threadsTotal?: number
  messagesTotal?: number
}

interface ExistenceSweepRequest {
  allMailThreadIds: string[]
  spamThreadIds: string[]
  trashThreadIds: string[]
}

interface FtsBackfillRequest {
  resetIndex?: boolean
  batchSize?: number
  pauseAfterBatches?: number
}

interface SearchIndexStatsRequest {
  queries: string[]
  runsPerQuery?: number
  limit?: number
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

function isFtsBackfillRequest(value: unknown): value is FtsBackfillRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<FtsBackfillRequest>
  return (
    (request.resetIndex === undefined || typeof request.resetIndex === 'boolean') &&
    optionalPositiveInteger(request.batchSize) &&
    optionalPositiveInteger(request.pauseAfterBatches)
  )
}

function isSearchIndexStatsRequest(value: unknown): value is SearchIndexStatsRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<SearchIndexStatsRequest>
  return (
    Array.isArray(request.queries) &&
    request.queries.length > 0 &&
    request.queries.every((query) => typeof query === 'string' && query.length > 0) &&
    optionalPositiveInteger(request.runsPerQuery) &&
    optionalPositiveInteger(request.limit)
  )
}

function isMessageMailbox(value: unknown): value is MessageMailbox {
  return value === 'all-mail' || value === 'spam' || value === 'trash'
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

function validDelay(value: unknown): number {
  return typeof value === 'number' && value >= 0 ? value : 0
}

function isLabelRows(value: unknown): value is LabelRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (label) =>
        typeof label === 'object' &&
        label !== null &&
        typeof (label as LabelRow).id === 'string' &&
        typeof (label as LabelRow).name === 'string' &&
        typeof (label as LabelRow).type === 'string'
    )
  )
}

function isLifetimeSweepRequest(value: unknown): value is LifetimeSweepRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<LifetimeSweepRequest>
  return (
    Array.isArray(request.threads) &&
    Array.isArray(request.pages) &&
    (request.threadCap === undefined || (Number.isSafeInteger(request.threadCap) && request.threadCap >= 0))
  )
}

function isExistenceSweepRequest(value: unknown): value is ExistenceSweepRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ExistenceSweepRequest>
  return [request.allMailThreadIds, request.spamThreadIds, request.trashThreadIds].every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')
  )
}
