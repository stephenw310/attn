import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import appIcon from '../../resources/icon.png?asset'
import type { AuthStatus } from '../shared/auth'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS, TEST_CHANNELS } from '../shared/ipc'
import type { SyncState } from '../shared/mail'
import type { OutboxChanged, OutboxProgress } from '../shared/outbox'
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
import { cleanOutboxSpool, reconcileOutboxSpool } from './outbox/spool'
import { SnoozeScheduler } from './scheduler'
import { writeSetting } from './settings'
import { deleteThread } from './sync/persist'
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
let testAttachmentPickerPaths: string[] | null = null
let signInInFlight = false
let teardownPromise: Promise<void> | null = null

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

function broadcastOutboxProgress(progress: OutboxProgress | null): void {
  broadcast(IPC_CHANNELS.outboxProgress, progress)
}

function broadcastBodyHydrationFailed(accountId: string, threadId: string): void {
  broadcast(IPC_CHANNELS.mailBodyHydrationFailed, { accountId, threadId })
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
  // A file dropped outside the composer's drop target must never replace the
  // sandboxed renderer with file:// content (or navigate it anywhere else).
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  // All external links open in the system browser, never in-app (SPEC §6).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

async function initialize(): Promise<void> {
  const dbPath = join(app.getPath('userData'), 'attn.db')
  db = openDatabase(dbPath)
  console.log(`[db] open at ${dbPath} (schema v${schemaVersion(db)})`)
  seedPath = testUserData ? process.env.ATTN_TEST_SEED : undefined
  if (seedPath) {
    const existing = db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
      | { id: string }
      | undefined
    seedAccountId = existing?.id ?? loadSeed(db, seedPath)
    console.log(`[sync] sent stage skipped for seeded account ${seedAccountId}`)
  }
  const activeDb = db
  await reconcileOutboxSpool(activeDb, app.getPath('userData'))
  syncController = new SyncController({
    db: activeDb,
    currentAccountId,
    isSignedIn: () => authStatus().signedIn,
    isSeeded,
    makeProvider,
    isForeground: () => BrowserWindow.getAllWindows().some((win) => win.isFocused()),
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
    pendingFocus: () => pendingFocus,
    clearPendingFocus: () => {
      pendingFocus = null
    },
    waitForConversation,
    pickAttachmentPaths: testUserData
      ? async () => {
          const paths = testAttachmentPickerPaths ?? []
          testAttachmentPickerPaths = null
          return paths
        }
      : undefined,
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
    (signal) => draftMirrorExecutor?.waitForIdle(signal) ?? Promise.resolve(),
    undefined,
    join(app.getPath('userData'), 'outbox'),
    (id) => cleanOutboxSpool(app.getPath('userData'), id),
    broadcastOutboxProgress
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
  ipcMain.on(TEST_CHANNELS.setAttachmentPickerFiles, (_event, paths: unknown) => {
    testAttachmentPickerPaths = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
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
}

function teardown(): Promise<void> {
  if (teardownPromise) return teardownPromise
  teardownPromise = teardownOwnedResources()
  return teardownPromise
}

async function teardownOwnedResources(): Promise<void> {
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
  const mirror = draftMirrorExecutor
  const sender = outboxSender
  snoozeScheduler?.stop()
  snoozeScheduler = null
  mailNotifier?.stop()
  mailNotifier = null
  for (const channel of Object.values(TEST_CHANNELS)) ipcMain.removeAllListeners(channel)
  testDraftSaveFailures = 0
  testDraftInlineImageDelayMs = 0
  testAttachmentPickerPaths = null
  const stopped = await Promise.allSettled([
    mirror?.stop() ?? Promise.resolve(),
    sender?.stop() ?? Promise.resolve()
  ])
  for (const result of stopped) {
    if (result.status === 'rejected') {
      console.error(`[shutdown] worker stop failed: ${String(result.reason)}`)
    }
  }
  draftMirrorExecutor = null
  outboxSender = null
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
    // Gmail draft creation is not idempotent. Quiesce both workers before
    // teardown closes SQLite, then stop before either can select another row.
    void teardown().finally(() => {
      quitPrepared = true
      app.quit()
    })
  })
  app.on('second-instance', () => showMainWindow())
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(appIcon)
    try {
      await initialize()
    } catch (error) {
      console.error(`[boot] failed: ${error instanceof Error ? error.message : String(error)}`)
      void teardown().finally(() => app.exit(1))
    }
  })
  // Deliberately keep the process alive with no windows so sync and
  // notifications continue running in the background on every platform.
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => void teardown())
}
