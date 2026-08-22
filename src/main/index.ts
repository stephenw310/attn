import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, powerMonitor, shell } from 'electron'
import appIcon from '../../resources/icon.png?asset'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import { errorMessage } from '../shared/error'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS } from '../shared/ipc'
import { oauthConfigSearchDirs } from './auth/configPaths'
import { cancelActiveSignIn, loadOAuthConfig, signInWithGoogle } from './auth/googleAuth'
import { clearTokens, loadTokens, saveTokens } from './auth/tokenStore'
import { isCurrentTokenUpdate } from './auth/tokenUpdate'
import { attachBackgroundWindow, initializeBackground, showMainWindow } from './background'
import { registerIpc } from './ipc'
import { MailNotifier, type PendingFocus } from './notify'
import {
  SERVICE_PROTOCOL_VERSION,
  type ServiceAuth,
  type ServiceEvent,
  type ServiceReady
} from './service/protocol'
import { ServiceSupervisor } from './service/supervisor'
import { TestSeams } from './testIpc'

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
        // Diagnostics must never break the app under test.
      }
    }
  }
}

let service: ServiceSupervisor | null = null
let seedAccountId: string | null = null
let stopIpc: (() => void) | null = null
let pendingFocus: PendingFocus | null = null
let signInInFlight = false
let authGeneration = 0
let teardownPromise: Promise<void> | null = null
let mailNotifier: MailNotifier | null = null

const testSeams = new TestSeams(Boolean(testUserData), {
  service: () => service,
  focusInboxThread
})

function broadcast<K extends BroadcastChannel>(channel: K, payload: BroadcastChannels[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
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

function currentServiceAuth(): ServiceAuth | null {
  const tokens = loadTokens(app.getPath('userData'))
  if (!tokens) return null
  return { config: loadOAuthConfig(oauthSearchDirs()), tokens, generation: authGeneration }
}

async function signIn(): Promise<AuthSignInResult> {
  const config = loadOAuthConfig(oauthSearchDirs())
  if (!config) {
    const resumedActions = Number((await service?.internal('resume-auth-failures')) ?? 0)
    return { status: authStatus(), resumedActions }
  }
  if (signInInFlight) cancelActiveSignIn()
  signInInFlight = true
  let resumedActions = 0
  try {
    const tokens = await signInWithGoogle(config, (url) => shell.openExternal(url))
    authGeneration++
    saveTokens(app.getPath('userData'), tokens)
    seedAccountId = null
    pendingFocus = null
    mailNotifier?.setAccountId(tokens.email ?? null)
    service?.setAuth({ config, tokens, generation: authGeneration })
    resumedActions = Number((await service?.internal('resume-auth-failures')) ?? 0)
    console.log(`[auth] signed in as ${tokens.email ?? 'unknown'}`)
  } catch (error) {
    console.error(`[auth] sign-in failed: ${errorMessage(error)}`)
    throw error
  } finally {
    signInInFlight = false
  }
  return { status: authStatus(), resumedActions }
}

function signOut(): AuthStatus {
  cancelActiveSignIn()
  authGeneration++
  service?.signOut()
  seedAccountId = null
  clearTokens(app.getPath('userData'))
  pendingFocus = null
  mailNotifier?.setAccountId(null)
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
    mailNotifier?.attachWindow(win)
    if (shouldShow) win.show()
  })
  win.on('focus', publishFocus)
  win.on('blur', publishFocus)
  attachBackgroundWindow(win)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function publishFocus(): void {
  service?.control({
    kind: 'focus',
    focused: BrowserWindow.getAllWindows().some((win) => win.isFocused())
  })
}

function handleServiceEvent(event: ServiceEvent): void {
  if (event.kind === 'mail-changed') broadcast(IPC_CHANNELS.mailChanged, undefined)
  else if (event.kind === 'outbox-changed') broadcast(IPC_CHANNELS.outboxChanged, event.payload)
  else if (event.kind === 'outbox-progress') broadcast(IPC_CHANNELS.outboxProgress, event.payload)
  else if (event.kind === 'sync-state') broadcast(IPC_CHANNELS.syncState, event.payload)
  else if (event.kind === 'body-hydration-failed') {
    broadcast(IPC_CHANNELS.mailBodyHydrationFailed, {
      accountId: event.accountId,
      threadId: event.threadId
    })
  } else if (event.kind === 'actions-reverted') {
    broadcast(IPC_CHANNELS.mailActionsReverted, undefined)
  } else if (event.kind === 'badge') mailNotifier?.updateBadge(event.unreadCount)
  else if (event.kind === 'notification-candidates') {
    mailNotifier?.notify(event.accountId, event.candidates, event.pausedUntil)
  } else if (event.kind === 'token-update') {
    const userDataPath = app.getPath('userData')
    if (!isCurrentTokenUpdate(authGeneration, loadTokens(userDataPath), event)) {
      console.warn(`[auth] ignored stale token update from generation ${event.generation}`)
      return
    }
    saveTokens(userDataPath, event.tokens)
    service?.cacheTokens(event.tokens)
  } else if (event.kind === 'log') console[event.level](event.message)
}

async function initialize(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const initialTokens = loadTokens(userDataPath)
  const ownedNotifier = new MailNotifier(initialTokens?.email ?? null, showMainWindow, focusInboxThread)
  mailNotifier = ownedNotifier
  ownedNotifier.start()
  const ownedService = new ServiceSupervisor(join(__dirname, 'service/utility.js'), {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    dbPath: join(userDataPath, 'attn.db'),
    userDataPath,
    downloadsPath: app.getPath('downloads'),
    testMode: Boolean(testUserData),
    ...(testUserData && process.env.ATTN_TEST_SEED ? { testSeed: process.env.ATTN_TEST_SEED } : {}),
    auth: currentServiceAuth(),
    focused: false
  })
  service = ownedService
  ownedService.onEvent(handleServiceEvent)
  let ready: ServiceReady
  try {
    ready = await ownedService.start()
  } catch (error) {
    if (service !== ownedService || mailNotifier !== ownedNotifier) return
    throw error
  }
  if (service !== ownedService || mailNotifier !== ownedNotifier) return
  seedAccountId = testUserData && process.env.ATTN_TEST_SEED ? ready.accountId : null
  ownedNotifier.setAccountId(ready.accountId)
  console.log(`[db] open at ${join(userDataPath, 'attn.db')} (schema v${ready.schemaVersion})`)
  console.log('[utility] service ready; SQLite ownership transferred')
  stopIpc = registerIpc({
    service: ownedService,
    authStatus,
    signIn,
    signOut,
    pendingFocus: () => pendingFocus,
    clearPendingFocus: () => {
      pendingFocus = null
    },
    pickAttachmentPaths: testUserData ? async () => testSeams.takeAttachmentPickerPaths() : undefined
  })
  powerMonitor.on('resume', refreshSchedulersAfterResume)
  const { startHidden } = initializeBackground(
    ready.background,
    {
      markLoginItemRegistered: () =>
        void service?.internal('mark-login-item-registered').catch((error) => {
          console.error(`[background] could not save login item state: ${errorMessage(error)}`)
        }),
      setNotificationPausedUntil: (pausedUntil) =>
        void service?.internal('set-notification-pause', pausedUntil).catch((error) => {
          console.error(`[notifications] could not save pause setting: ${errorMessage(error)}`)
        })
    },
    createWindow
  )
  createWindow({ show: !startHidden })
  testSeams.register()
  app.on('activate', () => showMainWindow())
}

function refreshSchedulersAfterResume(): void {
  service?.control({ kind: 'refresh-schedulers' })
}

function teardown(): Promise<void> {
  if (teardownPromise) return teardownPromise
  teardownPromise = teardownOwnedResources()
  return teardownPromise
}

async function teardownOwnedResources(): Promise<void> {
  stopIpc?.()
  stopIpc = null
  powerMonitor.removeListener('resume', refreshSchedulersAfterResume)
  testSeams.dispose()
  mailNotifier?.stop()
  mailNotifier = null
  const ownedService = service
  service = null
  await ownedService?.stop()
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
      console.error(`[boot] failed: ${errorMessage(error)}`)
      void teardown().finally(() => app.exit(1))
    }
  })
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => void teardown())
}
