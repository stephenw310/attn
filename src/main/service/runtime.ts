import { join } from 'node:path'
import type { RevertedAction } from '../../shared/actionRevert'
import { type InvokeChannel, TEST_CHANNELS } from '../../shared/ipc'
import type { MessageMailbox, SyncState } from '../../shared/mail'
import { clearUndo } from '../actions'
import { ActionExecutor, type ActionRecoveryProvider } from '../actions/executor'
import { ActionRevertNotices } from '../actions/revertNotices'
import type { TokenSet } from '../auth/googleAuth'
import { type Db, openDatabase, schemaVersion } from '../db'
import { countInboxUnread, listMailboxThreads } from '../db/queries'
import { loadSeed, readSeedThread } from '../dev/seed'
import { GmailApiError, GmailClient } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { GmailMailProvider } from '../gmail/provider'
import { DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE, GmailQuotaLimiter } from '../gmail/quota'
import { reconcileRemoteDraft } from '../outbox/draftSync'
import { DraftMirrorExecutor } from '../outbox/mirrorExecutor'
import { OutboxSender } from '../outbox/sender'
import { cleanOutboxSpool, reconcileOutboxSpool } from '../outbox/spool'
import { SnoozeScheduler } from '../scheduler'
import { readSetting, settingEnabled, writeSetting } from '../settings'
import { reconcileThreadExistence } from '../sync/existenceSweep'
import { runLifetimeSweep } from '../sync/lifetimeSweep'
import { deleteThread, type LabelRow } from '../sync/persist'
import { historyEvents, type NewMail } from '../sync/poller'
import type { MailProvider } from '../sync/provider'
import { SyncController } from '../syncController'
import { createServiceHandlers, type ServiceHandlers } from './handlers'
import { candidatesFor, notificationPausedUntil, setNotificationPausedUntil } from './notificationQueries'
import type {
  ServiceAuth,
  ServiceControl,
  ServiceEvent,
  ServiceInitialize,
  ServiceOperation,
  ServiceReady
} from './protocol'

export type ServiceEventSink = (event: ServiceEvent) => void

export class ServiceRuntime {
  private readonly db: Db
  private readonly actionRevertNotices = new ActionRevertNotices()
  private readonly foregroundProviderWork = new Map<string, number>()
  private readonly gmailQuotaLimiters = new Map<string, GmailQuotaLimiter>()
  private readonly handlers: ServiceHandlers
  private readonly actionExecutor: ActionExecutor
  private readonly draftMirrorExecutor: DraftMirrorExecutor
  private readonly outboxSender: OutboxSender
  private readonly snoozeScheduler: SnoozeScheduler
  private readonly syncController: SyncController
  private auth: ServiceAuth | null
  private seedAccountId: string | null = null
  private focused: boolean
  private stopped = false
  private draftSaveFailures = 0
  private conversationDelay: { threadId: string; delayMs: number } | null = null
  private draftReopenDelayMs = 0
  private draftInlineImageDelayMs = 0
  private actionProvider: ActionRecoveryProvider | null = null

  private readonly onNewMail = (newMail: NewMail[]): void => {
    const accountId = this.currentAccountId()
    if (!accountId) return
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
    this.auth = input.auth
    this.focused = input.focused
    this.db = openDatabase(input.dbPath)
    if (input.testSeed) {
      const existing = this.db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
        | { id: string }
        | undefined
      if (existing) this.seedAccountId = existing.id
      else {
        this.seedAccountId = loadSeed(this.db, input.testSeed).accountId
      }
      this.log('log', `[sync] backfill stages skipped for seeded account ${this.seedAccountId}`)
    }

    this.actionExecutor = new ActionExecutor(
      this.db,
      () => this.currentAccountId(),
      () => this.actionProvider ?? this.makeCurrentProvider(),
      {
        notify: () => this.broadcastMailChanged(),
        notifyReverted: (accountId, actions) => this.broadcastActionsReverted(accountId, actions)
      }
    )
    this.draftMirrorExecutor = new DraftMirrorExecutor(
      this.db,
      () => this.currentAccountId(),
      () => this.makeCurrentProvider(),
      { spoolRoot: join(input.userDataPath, 'outbox') }
    )
    this.outboxSender = new OutboxSender(
      this.db,
      () => this.currentAccountId(),
      () => this.makeCurrentProvider(),
      (payload) => this.emit({ kind: 'outbox-changed', payload }),
      {
        beforeRemote: (signal) => this.draftMirrorExecutor.waitForIdle(signal),
        spoolRoot: join(input.userDataPath, 'outbox'),
        cleanSpool: (id) => cleanOutboxSpool(input.userDataPath, id),
        progress: (payload) => this.emit({ kind: 'outbox-progress', payload }),
        mailChanged: () => this.broadcastMailChanged()
      }
    )
    this.snoozeScheduler = new SnoozeScheduler(
      this.db,
      () => this.currentAccountId(),
      () => this.broadcastMailChanged(),
      () => void this.actionExecutor.trigger()
    )
    this.syncController = new SyncController({
      db: this.db,
      currentAccountId: () => this.currentAccountId(),
      isSignedIn: () => this.isSignedIn(),
      isSeeded: () => this.seedAccountId !== null,
      makeProvider: (generation) => this.makeProvider(generation),
      isForeground: () => this.focused,
      hasForegroundProviderWork: (accountId) => (this.foregroundProviderWork.get(accountId) ?? 0) > 0,
      broadcastState: (payload) => this.emit({ kind: 'sync-state', payload }),
      broadcastMailChanged: () => this.broadcastMailChanged(),
      getActionExecutor: () => this.actionExecutor,
      getDraftMirrorExecutor: () => this.draftMirrorExecutor,
      getOutboxSender: () => this.outboxSender,
      getSnoozeScheduler: () => this.snoozeScheduler
    })
    this.handlers = createServiceHandlers({
      db: this.db,
      currentAccountId: () => this.currentAccountId(),
      makeClient: () => this.makeCurrentClient(),
      makeProvider: () => this.makeCurrentProvider(),
      isSeeded: () => this.seedAccountId !== null,
      executor: () => this.actionExecutor,
      draftMirrorExecutor: () => this.draftMirrorExecutor,
      outboxSender: () => this.outboxSender,
      scheduler: () => this.snoozeScheduler,
      syncController: () => this.syncController,
      broadcastMailChanged: () => this.broadcastMailChanged(),
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
      testUserData: input.testMode,
      userDataPath: input.userDataPath,
      downloadsPath: input.downloadsPath
    })
  }

  ready(): ServiceReady {
    return {
      accountId: this.currentAccountId(),
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
      const accountId = this.currentAccountId()
      if (!accountId) return 0
      const resumed = this.actionExecutor.resumeAuthFailures(accountId)
      if (resumed > 0) void this.syncController.resumeOnlineWork()
      return resumed
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
    if (control.kind === 'auth') {
      const previousAccount = this.currentAccountId()
      this.auth = control.auth
      const nextAccount = this.currentAccountId()
      this.disposeGmailQuotaLimiters(new Error(control.auth ? 'authentication changed' : 'signed out'))
      if (control.auth) this.syncController.onSignIn()
      else this.syncController.onSignOut()
      if (previousAccount && previousAccount !== nextAccount) this.actionRevertNotices.clear(previousAccount)
      this.snoozeScheduler.refresh()
      this.outboxSender.refresh()
      this.broadcastBadge()
      return
    }
    if (control.kind === 'sign-out') {
      const previousAccount = this.currentAccountId()
      this.auth = null
      this.seedAccountId = null
      this.disposeGmailQuotaLimiters(new Error('signed out'))
      this.syncController.onSignOut()
      if (previousAccount) {
        this.actionRevertNotices.clear(previousAccount)
        clearUndo(previousAccount)
      }
      this.snoozeScheduler.refresh()
      this.outboxSender.refresh()
      this.broadcastBadge()
      return
    }
    if (control.kind === 'focus') {
      this.focused = control.focused
      return
    }
    if (control.kind === 'resume') {
      void this.syncController.resumeOnlineWork()
      return
    }
    if (control.kind === 'refresh-schedulers') {
      this.snoozeScheduler.refresh()
      this.outboxSender.refresh()
      return
    }
    if (control.kind === 'stop') void this.stop()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    historyEvents.off('newMail', this.onNewMail)
    this.handlers.stop()
    this.syncController.stop()
    this.actionExecutor.stop()
    this.snoozeScheduler.stop()
    const stopped = await Promise.allSettled([this.draftMirrorExecutor.stop(), this.outboxSender.stop()])
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
    this.snoozeScheduler.start()
    this.outboxSender.start()
    this.broadcastBadge()
    if (this.isSignedIn()) void this.syncController.resumeOnlineWork()
  }

  private currentAccountId(): string | null {
    return this.seedAccountId ?? this.auth?.tokens.email ?? null
  }

  private isSignedIn(): boolean {
    return this.seedAccountId !== null || this.auth !== null
  }

  private makeClient(generation: number): GmailClient | null {
    const auth = this.auth
    if (!auth?.config) return null
    const quotaAccount = auth.tokens.email ?? 'unknown-account'
    let quotaLimiter = this.gmailQuotaLimiters.get(quotaAccount)
    if (!quotaLimiter) {
      quotaLimiter = new GmailQuotaLimiter({
        unitsPerMinute: auth.config.quota_units_per_minute ?? DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE
      })
      this.gmailQuotaLimiters.set(quotaAccount, quotaLimiter)
    }
    return new GmailClient(
      auth.config,
      auth.tokens,
      (tokens: TokenSet) => {
        if (generation !== this.syncController.getGeneration()) return
        this.auth = { config: auth.config, tokens, generation: auth.generation }
        this.emit({ kind: 'token-update', tokens, generation: auth.generation })
      },
      { quotaLimiter }
    )
  }

  private makeCurrentClient(): GmailClient | null {
    return this.makeClient(this.syncController.getGeneration())
  }

  private makeProvider(generation: number): GmailMailProvider | null {
    if (this.seedAccountId) return null
    const client = this.makeClient(generation)
    return client ? new GmailMailProvider(client) : null
  }

  private makeCurrentProvider(): GmailMailProvider | null {
    return this.makeProvider(this.syncController.getGeneration())
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

  private broadcastMailChanged(): void {
    this.emit({ kind: 'mail-changed' })
    this.broadcastBadge()
  }

  private broadcastBadge(): void {
    const accountId = this.currentAccountId()
    this.emit({ kind: 'badge', unreadCount: accountId ? countInboxUnread(this.db, accountId) : 0 })
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
    const accountId = this.currentAccountId()
    if (channel === TEST_CHANNELS.setSyncState) {
      this.syncController.setStateForTest(args[0] as SyncState)
      return undefined
    }
    if (channel === TEST_CHANNELS.reloadSeed) {
      if (!this.input.testSeed) throw new Error('seed store unavailable')
      const labels = args[0]
      if (labels !== undefined && !isLabelRows(labels)) throw new Error('invalid authoritative label catalog')
      const result = loadSeed(this.db, this.input.testSeed, labels === undefined ? {} : { labels })
      if (result.labelsChanged) this.broadcastMailChanged()
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
    if (channel === TEST_CHANNELS.updateMessageBody) {
      const [messageId, bodyText] = args
      if (!accountId || typeof messageId !== 'string' || typeof bodyText !== 'string') {
        throw new Error('invalid message update')
      }
      this.db
        .prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?')
        .run(bodyText, accountId, messageId)
      this.broadcastMailChanged()
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
      if (typeof seconds === 'number' && [0, 5, 8, 10, 20, 30].includes(seconds)) {
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
      this.broadcastMailChanged()
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
          'SELECT backfill_cursor, sweep_cursor, attachment_cursor FROM sync_state WHERE account_id = ?'
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
    const accountId = this.currentAccountId()
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
      { requestIntervalMs: 0, pagePauseMs: 0 }
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

  private async runTestExistenceSweep(value: unknown): Promise<unknown> {
    const accountId = this.currentAccountId()
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
    if (result?.deletedThreadIds.length) this.broadcastMailChanged()
    return result
  }

  private log(level: 'log' | 'warn' | 'error', message: string): void {
    this.emit({ kind: 'log', level, message })
  }
}

interface LifetimeSweepRequest {
  resetCursor?: string
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

function isMessageMailbox(value: unknown): value is MessageMailbox {
  return value === 'all-mail' || value === 'spam' || value === 'trash'
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
  return Array.isArray(request.threads) && Array.isArray(request.pages)
}

function isExistenceSweepRequest(value: unknown): value is ExistenceSweepRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ExistenceSweepRequest>
  return [request.allMailThreadIds, request.spamThreadIds, request.trashThreadIds].every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')
  )
}
