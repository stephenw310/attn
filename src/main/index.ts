import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import appIcon from '../../resources/icon.png?asset'
import type { AuthStatus } from '../shared/auth'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS } from '../shared/ipc'
import type { SyncState } from '../shared/mail'
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
import { SnoozeScheduler } from './scheduler'
import { SyncController } from './syncController'

const testUserData = process.env.ATTN_TEST_USER_DATA
if (testUserData) {
  app.setPath('userData', testUserData)
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
let actionExecutor: ActionExecutor | null = null
let snoozeScheduler: SnoozeScheduler | null = null
let mailNotifier: MailNotifier | null = null
let syncController: SyncController | null = null
let pendingFocus: PendingFocus | null = null
let signInInFlight = false

function broadcast<K extends BroadcastChannel>(channel: K, payload: BroadcastChannels[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function broadcastMailChanged(): void {
  broadcast(IPC_CHANNELS.mailChanged, undefined)
  mailNotifier?.updateBadge()
}

function focusInboxThread(threadId: string): void {
  pendingFocus = { threadId, at: Date.now() }
  const win = showMainWindow()
  console.log(`[notify] focus requested for ${threadId} (window ${win ? 'available' : 'pending'})`)
  win?.webContents.send(IPC_CHANNELS.mailFocusThreadAvailable)
}

function oauthSearchDirs(): string[] {
  return oauthConfigSearchDirs(app.getAppPath(), app.getPath('userData'), Boolean(testUserData))
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

function makeClient(generation = syncController?.getGeneration() ?? 0): GmailClient | null {
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  if (!config || !tokens) return null
  return new GmailClient(config, tokens, (nextTokens) => {
    if (generation === syncController?.getGeneration()) {
      saveTokens(app.getPath('userData'), nextTokens)
    }
  })
}

function makeProvider(generation: number): GmailMailProvider | null {
  if (seedAccountId) return null
  const client = makeClient(generation)
  return client ? new GmailMailProvider(client) : null
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
  const seedPath = testUserData ? process.env.ATTN_TEST_SEED : undefined
  if (seedPath) {
    const existing = db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
      | { id: string }
      | undefined
    seedAccountId = existing?.id ?? loadSeed(db, seedPath)
  }
  const activeDb = db
  syncController = new SyncController({
    db: activeDb,
    currentAccountId,
    isSignedIn: () => authStatus().signedIn,
    isSeeded: () => seedAccountId !== null,
    makeProvider,
    broadcastState: (state) => broadcast(IPC_CHANNELS.syncState, state),
    broadcastMailChanged,
    getActionExecutor: () => actionExecutor,
    getSnoozeScheduler: () => snoozeScheduler
  })
  registerIpc({
    db: activeDb,
    currentAccountId,
    authStatus,
    signIn,
    signOut,
    makeClient,
    isSeeded: () => seedAccountId !== null,
    executor: () => actionExecutor,
    scheduler: () => snoozeScheduler,
    notifier: () => mailNotifier,
    syncController,
    broadcastMailChanged,
    takePendingFocus: () => pendingFocus,
    clearPendingFocus: () => {
      pendingFocus = null
    },
    testUserData: Boolean(testUserData)
  })
  actionExecutor = new ActionExecutor(
    activeDb,
    currentAccountId,
    () => makeProvider(syncController?.getGeneration() ?? 0),
    broadcastMailChanged
  )
  snoozeScheduler = new SnoozeScheduler(
    activeDb,
    currentAccountId,
    broadcastMailChanged,
    () => void actionExecutor?.trigger()
  )
  snoozeScheduler.start()
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
  ipcMain.on('attn:test:focusThread', (_event, threadId: unknown) => {
    if (typeof threadId === 'string' && threadId.length > 0) focusInboxThread(threadId)
  })
  ipcMain.on('attn:test:setSyncState', (_event, state: SyncState) => broadcast(IPC_CHANNELS.syncState, state))
}

function teardown(): void {
  syncController?.stop()
  syncController = null
  powerMonitor.removeListener('resume', refreshSnoozesAfterResume)
  actionExecutor?.stop()
  actionExecutor = null
  snoozeScheduler?.stop()
  snoozeScheduler = null
  mailNotifier?.stop()
  mailNotifier = null
  ipcMain.removeAllListeners('attn:test:focusThread')
  ipcMain.removeAllListeners('attn:test:setSyncState')
  db?.close()
  db = null
}

function refreshSnoozesAfterResume(): void {
  snoozeScheduler?.refresh()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', () => showMainWindow())
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(appIcon)
    try {
      initialize()
    } catch (error) {
      console.error(`[boot] failed: ${error instanceof Error ? error.message : String(error)}`)
      app.exit(1)
    }
  })
  app.on('window-all-closed', () => {})
  app.on('will-quit', teardown)
}
