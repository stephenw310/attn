import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import appIcon from '../../resources/icon.png?asset'
import type { AuthStatus } from '../shared/auth'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS, TEST_CHANNELS } from '../shared/ipc'
import type { SyncState } from '../shared/mail'
import type { OutboxChanged } from '../shared/outbox'
import { clearUndo } from './actions'
import { ActionExecutor } from './actions/executor'
import { oauthConfigSearchDirs } from './auth/configPaths'
import { cancelActiveSignIn, loadOAuthConfig, signInWithGoogle } from './auth/googleAuth'
import { clearTokens, loadTokens, saveTokens } from './auth/tokenStore'
import { attachBackgroundWindow, initializeBackground, showMainWindow } from './background'
import { type Db, openDatabase, schemaVersion } from './db'
import { loadSeed } from './dev/seed'
import { GmailClient } from './gmail/client'
import { GmailMailProvider } from './gmail/provider'
import { registerIpc } from './ipc'
import { MailNotifier, type PendingFocus } from './notify'
import { reconcileRemoteDraft } from './outbox/draftSync'
import { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import { OutboxSender } from './outbox/sender'
import { cleanOutboxSpool } from './outbox/spool'
import { SnoozeScheduler } from './scheduler'
import { writeSetting } from './settings'
import { runLifetimeSweep } from './sync/lifetimeSweep'
import { deleteThread } from './sync/persist'
import type { MailProvider } from './sync/provider'
import { SyncController } from './syncController'

// E2E seam: an isolated userData dir gives each test run a fresh DB and empty
// token store. Must be set before requestSingleInstanceLock() so concurrent
// test apps (distinct dirs) don't share an instance lock.
const testUserData = process.env.ATTN_TEST_USER_DATA
if (testUserData) {
  app.setPath('userData', testUserData)
  // Mirror console output to a file the e2e fixture attaches on failure —
  // Playwright consumes early stdout before test listeners can attach, so
  // boot-time lines would otherwise be lost to diagnostics.
  const logFile = join(testUserData, 'main.log')
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        appendFileSync(logFile, `[${level}] ${args.map(String).join(' ')}\n`)
      } catch {
        // Diagnostics only — never let logging break the app under test.
      }
    }
  }
}

let db: Db | null = null
let seedAccountId: string | null = null
let seedPath: string | undefined
let actionExecutor: ActionExecutor | null = null
let draftMirrorExecutor: DraftMirrorExecutor | null = null
let outboxSender: OutboxSender | null = null
let snoozeScheduler: SnoozeScheduler | null = null
let mailNotifier: MailNotifier | null = null
let syncController: SyncController | null = null
let stopIpc: (() => void) | null = null
let pendingFocus: PendingFocus | null = null
let testConversationDelay: { threadId: string; delayMs: number } | null = null
let testDraftInlineImageDelayMs = 0
let testDraftSaveFailures = 0
let signInInFlight = false
const foregroundProviderWork = new Map<string, number>()

function broadcast<K extends BroadcastChannel>(channel: K, payload: BroadcastChannels[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function broadcastMailChanged(): void {
  broadcast(IPC_CHANNELS.mailChanged, undefined)
  mailNotifier?.updateBadge()
}

function broadcastOutboxChanged(change: OutboxChanged): void {
  broadcast(IPC_CHANNELS.outboxChanged, change)
  mailNotifier?.updateBadge()
}

function broadcastBodyHydrationFailed(accountId: string, threadId: string): void {
  broadcast(IPC_CHANNELS.mailBodyHydrationFailed, { accountId, threadId })
}

function hasForegroundProviderWork(accountId: string): boolean {
  return (foregroundProviderWork.get(accountId) ?? 0) > 0
}

async function trackForegroundProviderWork<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  foregroundProviderWork.set(accountId, (foregroundProviderWork.get(accountId) ?? 0) + 1)
  try {
    return await work()
  } finally {
    const remaining = (foregroundProviderWork.get(accountId) ?? 1) - 1
    if (remaining > 0) foregroundProviderWork.set(accountId, remaining)
    else foregroundProviderWork.delete(accountId)
  }
}

function focusInboxThread(threadId: string): void {
  pendingFocus = { threadId, at: Date.now() }
  const win = showMainWindow()
  console.log(`[notify] focus requested for ${threadId} (window ${win ? 'available' : 'pending'})`)
  win?.webContents.send(IPC_CHANNELS.mailFocusThreadAvailable)
}

function oauthSearchDirs(): string[] {
  // Under e2e, only the isolated dir — a developer's real oauth.config.json in
  // either checkout must never leak into test runs.
  return oauthConfigSearchDirs(app.getAppPath(), app.getPath('userData'), Boolean(testUserData))
}

function isSeeded(): boolean {
  return seedAccountId !== null
}

function authStatus(): AuthStatus {
  if (seedAccountId) return { configured: false, signedIn: true, email: seedAccountId }
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  return { configured: config !== null, signedIn: tokens !== null, email: tokens?.email }
}

function currentAccountId(): string | null {
  return seedAccountId ?? loadTokens(app.getPath('userData'))?.email ?? null
}

function makeClient(generation: number): GmailClient | null {
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  if (!config || !tokens) return null
  return new GmailClient(config, tokens, (nextTokens) => {
    if (generation === syncController?.getGeneration()) {
      saveTokens(app.getPath('userData'), nextTokens)
    }
  })
}

function makeCurrentClient(): GmailClient | null {
  const controller = syncController
  return controller ? makeClient(controller.getGeneration()) : null
}

function makeProvider(generation: number): GmailMailProvider | null {
  if (seedAccountId) return null
  const client = makeClient(generation)
  return client ? new GmailMailProvider(client) : null
}

function makeCurrentProvider(): GmailMailProvider | null {
  const controller = syncController
  return controller ? makeProvider(controller.getGeneration()) : null
}

async function waitForConversation(threadId: string): Promise<void> {
  const delay = testConversationDelay
  if (!testUserData || delay?.threadId !== threadId) return
  await new Promise((resolve) => setTimeout(resolve, delay.delayMs))
}

async function signIn(): Promise<AuthStatus> {
  const config = loadOAuthConfig(oauthSearchDirs())
  if (!config) return authStatus()
  if (signInInFlight) cancelActiveSignIn()
  signInInFlight = true
  try {
    const tokens = await signInWithGoogle(config, (url) => shell.openExternal(url))
    saveTokens(app.getPath('userData'), tokens)
    pendingFocus = null
    mailNotifier?.setAccountId(tokens.email ?? null)
    console.log(`[auth] signed in as ${tokens.email ?? 'unknown'}`)
    snoozeScheduler?.refresh()
    syncController?.onSignIn()
  } catch (error) {
    console.error('[auth] sign-in failed:', error instanceof Error ? error.message : error)
    throw error
  } finally {
    signInInFlight = false
  }
  return authStatus()
}

function signOut(): AuthStatus {
  const account = currentAccountId()
  cancelActiveSignIn()
  syncController?.onSignOut()
  seedAccountId = null
  clearTokens(app.getPath('userData'))
  pendingFocus = null
  mailNotifier?.setAccountId(null)
  clearUndo(account ?? undefined)
  snoozeScheduler?.refresh()
  outboxSender?.refresh()
  console.log('[auth] signed out')
  return authStatus()
}

function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const shouldShow = options.show ?? true
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    icon: appIcon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // HTML mail lives in our scriptless srcdoc frame. Some legitimate senders
  // serve images with CORP: same-origin, which Chromium otherwise blocks in
  // that frame. Remove only that embedding response header for image requests
  // from the mail frame; the renderer still loads the original URL directly.
  win.webContents.session.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'], types: ['image'] },
    (details, callback) => {
      if (details.frame?.url !== 'about:srcdoc' || !details.responseHeaders) {
        callback({})
        return
      }
      const responseHeaders = { ...details.responseHeaders }
      let changed = false
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase() !== 'cross-origin-resource-policy') continue
        delete responseHeaders[name]
        changed = true
      }
      callback(changed ? { responseHeaders } : {})
    }
  )
  win.on('ready-to-show', () => {
    if (shouldShow) win.show()
  })
  attachBackgroundWindow(win)
  // All external links open in the system browser, never in-app (SPEC §6).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function initialize(): void {
  const dbPath = join(app.getPath('userData'), 'attn.db')
  db = openDatabase(dbPath)
  console.log(`[db] open at ${dbPath} (schema v${schemaVersion(db)})`)
  seedPath = testUserData ? process.env.ATTN_TEST_SEED : undefined
  if (seedPath) {
    const existing = db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
      | { id: string }
      | undefined
    seedAccountId = existing?.id ?? loadSeed(db, seedPath)
    console.log(`[sync] backfill stages skipped for seeded account ${seedAccountId}`)
  }
  const activeDb = db
  syncController = new SyncController({
    db: activeDb,
    currentAccountId,
    isSignedIn: () => authStatus().signedIn,
    isSeeded,
    makeProvider,
    isForeground: () => BrowserWindow.getAllWindows().some((win) => win.isFocused()),
    hasForegroundProviderWork,
    broadcastState: (state) => broadcast(IPC_CHANNELS.syncState, state),
    broadcastMailChanged,
    getActionExecutor: () => actionExecutor,
    getDraftMirrorExecutor: () => draftMirrorExecutor,
    getOutboxSender: () => outboxSender,
    getSnoozeScheduler: () => snoozeScheduler
  })
  stopIpc = registerIpc({
    db: activeDb,
    currentAccountId,
    authStatus,
    signIn,
    signOut,
    makeClient: makeCurrentClient,
    makeProvider: makeCurrentProvider,
    isSeeded,
    executor: () => actionExecutor,
    draftMirrorExecutor: () => draftMirrorExecutor,
    outboxSender: () => outboxSender,
    scheduler: () => snoozeScheduler,
    syncController: () => syncController,
    broadcastMailChanged,
    broadcastOutboxChanged,
    broadcastBodyHydrationFailed,
    trackForegroundProviderWork,
    pendingFocus: () => pendingFocus,
    clearPendingFocus: () => {
      pendingFocus = null
    },
    waitForConversation,
    draftInlineImageDelay: () => testDraftInlineImageDelayMs,
    consumeTestDraftSaveFailure: () => {
      if (testDraftSaveFailures === 0) return false
      testDraftSaveFailures--
      return true
    },
    testUserData: Boolean(testUserData)
  })
  actionExecutor = new ActionExecutor(activeDb, currentAccountId, makeCurrentProvider, broadcastMailChanged)
  draftMirrorExecutor = new DraftMirrorExecutor(
    activeDb,
    currentAccountId,
    makeCurrentProvider,
    undefined,
    undefined,
    join(app.getPath('userData'), 'outbox')
  )
  outboxSender = new OutboxSender(
    activeDb,
    currentAccountId,
    makeCurrentProvider,
    broadcastOutboxChanged,
    () => draftMirrorExecutor?.waitForIdle() ?? Promise.resolve(),
    undefined,
    join(app.getPath('userData'), 'outbox'),
    (id) => cleanOutboxSpool(app.getPath('userData'), id)
  )
  snoozeScheduler = new SnoozeScheduler(
    activeDb,
    currentAccountId,
    broadcastMailChanged,
    () => void actionExecutor?.trigger()
  )
  snoozeScheduler.start()
  outboxSender.start()
  powerMonitor.on('resume', refreshSnoozesAfterResume)
  const { startHidden } = initializeBackground(activeDb, createWindow)
  createWindow({ show: !startHidden })
  mailNotifier = new MailNotifier(activeDb, currentAccountId(), showMainWindow, focusInboxThread)
  mailNotifier.start()
  registerTestIpc()
  if (authStatus().signedIn) void syncController.resumeOnlineWork()
  app.on('activate', () => showMainWindow())
}

function registerTestIpc(): void {
  if (!testUserData) return
  ipcMain.on(TEST_CHANNELS.focusThread, (_event, threadId: unknown) => {
    if (typeof threadId === 'string' && threadId.length > 0) focusInboxThread(threadId)
  })
  ipcMain.on(TEST_CHANNELS.setSyncState, (_event, state: SyncState) => syncController?.setStateForTest(state))
  ipcMain.on(TEST_CHANNELS.reloadSeed, (_event, done: (error?: string) => void) => {
    // Avoid re-entering better-sqlite3 if the renderer is finishing an IPC read
    // in the same turn, and let the test wait for the replay to commit.
    setImmediate(() => {
      try {
        if (db && seedPath) loadSeed(db, seedPath)
        done()
      } catch (error) {
        done(error instanceof Error ? error.message : String(error))
      }
    })
  })
  ipcMain.on(TEST_CHANNELS.deleteThread, (_event, threadId: unknown) => {
    const account = currentAccountId()
    if (db && account && typeof threadId === 'string') deleteThread(db, account, threadId)
  })
  ipcMain.on(TEST_CHANNELS.delayConversation, (_event, threadId: unknown, delayMs: unknown) => {
    if (typeof threadId !== 'string' || typeof delayMs !== 'number' || delayMs < 0) return
    testConversationDelay = { threadId, delayMs }
  })
  ipcMain.on(TEST_CHANNELS.delayDraftInlineImage, (_event, delayMs: unknown) => {
    testDraftInlineImageDelayMs = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 0
  })
  ipcMain.on(
    TEST_CHANNELS.updateMessageBody,
    (_event, messageId: unknown, bodyText: unknown, done?: (error?: string) => void) => {
      // electronApplication.evaluate can interrupt a synchronous SQLite read
      // in the inspector context. Queue the mutation onto the next main-loop
      // turn and let the test wait until the write and invalidation complete.
      setImmediate(() => {
        try {
          if (!db || typeof messageId !== 'string' || typeof bodyText !== 'string') {
            done?.('invalid message update')
            return
          }
          const account = currentAccountId()
          if (!account) {
            done?.('account unavailable')
            return
          }
          db.prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?').run(
            bodyText,
            account,
            messageId
          )
          broadcastMailChanged()
          done?.()
        } catch (error) {
          done?.(error instanceof Error ? error.message : String(error))
        }
      })
    }
  )
  ipcMain.on(TEST_CHANNELS.failNextDraftSave, () => {
    testDraftSaveFailures++
  })
  ipcMain.on(
    TEST_CHANNELS.markDraftMirrored,
    (_event, draftId: unknown, gmailDraftId?: unknown, done?: (error?: string) => void) => {
      // Inspector evaluation can interrupt a renderer-initiated synchronous
      // SQLite read. Defer this test mutation onto the next main-loop turn.
      setImmediate(() => {
        try {
          const account = currentAccountId()
          if (!db || !account || typeof draftId !== 'string') {
            done?.('invalid mirrored draft update')
            return
          }
          db.prepare(
            `UPDATE outbox SET mirror_revision = local_revision,
             gmail_draft_id = COALESCE(?, gmail_draft_id)
             WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')`
          ).run(typeof gmailDraftId === 'string' ? gmailDraftId : null, account, draftId)
          done?.()
        } catch (error) {
          done?.(error instanceof Error ? error.message : String(error))
        }
      })
    }
  )
  ipcMain.on(TEST_CHANNELS.setUndoSendDelay, (_event, seconds: unknown) => {
    if (!db || typeof seconds !== 'number' || ![0, 5, 8, 10, 20, 30].includes(seconds)) return
    writeSetting(db, 'undoSendDelaySeconds', String(seconds))
  })
  ipcMain.on(
    TEST_CHANNELS.failOutbox,
    (_event, id: unknown, message: unknown, done?: (error?: string) => void) => {
      setImmediate(() => {
        try {
          const account = currentAccountId()
          if (!db || !account || typeof id !== 'string' || typeof message !== 'string') {
            done?.('invalid outbox failure')
            return
          }
          const result = db
            .prepare(
              `UPDATE outbox SET state = 'failed', send_at = NULL, last_error = ?
               WHERE account_id = ? AND id = ? AND state = 'queued'`
            )
            .run(message, account, id)
          done?.(result.changes > 0 ? undefined : 'queued message unavailable')
        } catch (error) {
          done?.(error instanceof Error ? error.message : String(error))
        }
      })
    }
  )
  ipcMain.on(TEST_CHANNELS.remoteDraft, (_event, remote: unknown, done?: (error?: string) => void) => {
    // Inspector evaluation can interrupt a renderer-initiated SQLite read.
    // Defer this test-only reconciliation onto the next main-loop turn.
    setImmediate(() => {
      const account = currentAccountId()
      if (!db || !account || !remote || typeof remote !== 'object') {
        done?.('invalid remote draft')
        return
      }
      void reconcileRemoteDraft(db, account, remote as Parameters<typeof reconcileRemoteDraft>[2])
        .then(() => {
          broadcastMailChanged()
          done?.()
        })
        .catch((error: unknown) => {
          done?.(error instanceof Error ? error.message : String(error))
        })
    })
  })
  ipcMain.on(
    TEST_CHANNELS.runLifetimeSweep,
    async (
      _event,
      request: {
        resetCursor?: string
        threads: import('./gmail/parse').GmailThread[]
        pages: Array<{
          pageToken?: string
          threadIds: string[]
          nextPageToken?: string
          resultSizeEstimate?: number
        }>
        offlineAtPageToken?: string
        threadsTotal?: number
        messagesTotal?: number
      },
      done: (result: {
        cursor: string | null
        error?: string
        formats: string[]
        pageTokens: Array<string | undefined>
      }) => void
    ) => {
      const accountId = currentAccountId()
      if (!db || !accountId || !request || !Array.isArray(request.threads)) {
        done({ cursor: null, error: 'invalid lifetime sweep request', formats: [], pageTokens: [] })
        return
      }
      if (request.resetCursor) {
        db.prepare(
          `UPDATE sync_state
           SET sweep_cursor = ?, sweep_threads_done = 0, sweep_threads_total = NULL
           WHERE account_id = ?`
        ).run(request.resetCursor, accountId)
      }
      const threads = new Map(request.threads.map((thread) => [thread.id, thread]))
      const formats: string[] = []
      const pageTokens: Array<string | undefined> = []
      let failure: unknown
      const provider = {
        getProfile: async () => ({
          emailAddress: accountId,
          historyId: 'test-history',
          threadsTotal: request.threadsTotal,
          messagesTotal: request.messagesTotal
        }),
        listThreadIds: async (options = {}) => {
          pageTokens.push(options.pageToken)
          if (request.offlineAtPageToken !== undefined && options.pageToken === request.offlineAtPageToken) {
            throw new Error('offline')
          }
          const page = request.pages.find((candidate) => candidate.pageToken === options.pageToken)
          if (!page) return { threadIds: [] }
          return page
        },
        getThread: async (id: string, options = {}) => {
          formats.push(options.format ?? 'full')
          const thread = threads.get(id)
          if (!thread) throw new Error(`missing test thread ${id}`)
          return thread
        }
      } as MailProvider
      await runLifetimeSweep(
        db,
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
      const state = db.prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
        | { sweep_cursor: string | null }
        | undefined
      done({
        cursor: state?.sweep_cursor ?? null,
        ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
        formats,
        pageTokens
      })
    }
  )
}

function teardown(): void {
  // Invoke handlers close over process-owned resources, so remove them before
  // stopping those resources. Iterating the channel map keeps this exhaustive.
  for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel)
  stopIpc?.()
  stopIpc = null
  syncController?.stop()
  syncController = null
  powerMonitor.removeListener('resume', refreshSnoozesAfterResume)
  actionExecutor?.stop()
  actionExecutor = null
  void draftMirrorExecutor?.stop()
  draftMirrorExecutor = null
  void outboxSender?.stop()
  outboxSender = null
  snoozeScheduler?.stop()
  snoozeScheduler = null
  mailNotifier?.stop()
  mailNotifier = null
  for (const channel of Object.values(TEST_CHANNELS)) ipcMain.removeAllListeners(channel)
  testDraftSaveFailures = 0
  testDraftInlineImageDelayMs = 0
  db?.close()
  db = null
}

function refreshSnoozesAfterResume(): void {
  snoozeScheduler?.refresh()
  outboxSender?.refresh()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  let quitPrepared = false
  let preparingQuit = false
  app.on('before-quit', (event) => {
    if (quitPrepared) return
    event.preventDefault()
    if (preparingQuit) return
    preparingQuit = true
    // Give active draft/outbox mutations a bounded grace period to persist their
    // recovery state before will-quit closes SQLite.
    void Promise.all([
      draftMirrorExecutor?.stop() ?? Promise.resolve(),
      outboxSender?.stop() ?? Promise.resolve()
    ]).finally(() => {
      quitPrepared = true
      app.quit()
    })
  })
  app.on('second-instance', () => showMainWindow())
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(appIcon)
    try {
      initialize()
    } catch (error) {
      console.error(`[boot] failed: ${error instanceof Error ? error.message : String(error)}`)
      teardown()
      app.exit(1)
    }
  })
  // Deliberately keep the process alive with no windows so sync and
  // notifications continue running in the background on every platform.
  app.on('window-all-closed', () => {})
  app.on('will-quit', teardown)
}
