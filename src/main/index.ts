import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, powerMonitor, shell } from 'electron'
import appIcon from '../../resources/icon.png?asset'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import { errorMessage } from '../shared/error'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS } from '../shared/ipc'
import type { ThemePreference } from '../shared/theme'
import { oauthConfigSearchDirs } from './auth/configPaths'
import { cancelActiveSignIn, loadOAuthConfig, signInWithGoogle } from './auth/googleAuth'
import { accountIdForTokens, type StoredAccount } from './auth/tokenFile'
import { loadAccounts, removeAccountTokens, saveAccountTokens } from './auth/tokenStore'
import { isCurrentTokenUpdate } from './auth/tokenUpdate'
import { attachBackgroundWindow, initializeBackground, showMainWindow } from './background'
import { registerIpc } from './ipc'
import { MailNotifier, type PendingFocus, takePendingFocus } from './notify'
import {
  SERVICE_PROTOCOL_VERSION,
  type ServiceAccountsState,
  type ServiceEvent,
  type ServiceReady
} from './service/protocol'
import { ServiceSupervisor } from './service/supervisor'
import { TestSeams } from './testIpc'
import { titleBarOverlayOptions, windowChromeOptions } from './windowChrome'

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
let seedAccountIds: string[] = []
let storedAccounts: StoredAccount[] = []
let activeAccountId: string | null = null
let stopIpc: (() => void) | null = null
let pendingFocus: PendingFocus | null = null
let signInInFlight = false
const authGenerations = new Map<string, number>()
let teardownPromise: Promise<void> | null = null
let mailNotifier: MailNotifier | null = null
let themePreference: ThemePreference = 'system'

const testSeams = new TestSeams(Boolean(testUserData), {
  service: () => service,
  focusInboxThread: (threadId, accountId) => {
    const owner = accountId ?? activeAccountId
    if (owner) focusInboxThread(owner, threadId)
  }
})

function broadcast<K extends BroadcastChannel>(channel: K, payload: BroadcastChannels[K]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function focusInboxThread(accountId: string, threadId: string | null): void {
  pendingFocus = { accountId, ...(threadId ? { threadId } : {}), at: Date.now() }
  const win = showMainWindow()
  console.log(
    `[notify] focus requested for ${accountId} ${threadId ?? '(inbox)'} (window ${win ? 'available' : 'pending'})`
  )
  win?.webContents.send(IPC_CHANNELS.mailFocusThreadAvailable)
}

/**
 * Consume the pending focus target for the account on screen. A `switch` ask
 * leaves the target pending: the renderer runs its guarded account switch and
 * the remounted tree pulls again, now matching. Anything else — consumed,
 * expired, or absent — clears it.
 */
function takePendingFocusTarget(): ReturnType<typeof takePendingFocus> {
  const target = takePendingFocus(pendingFocus, activeAccountId)
  if (target?.kind !== 'switch') pendingFocus = null
  return target
}

/**
 * An active-account change consumes or drops the pending focus target: it
 * survives only when it names the account now active (the notification-driven
 * switch completing). A manual switch elsewhere discards it rather than
 * bouncing the user to the notified account later.
 */
function reconcilePendingFocus(): void {
  if (pendingFocus && pendingFocus.accountId !== activeAccountId) pendingFocus = null
}

function oauthSearchDirs(): string[] {
  return oauthConfigSearchDirs(app.getAppPath(), app.getPath('userData'), Boolean(testUserData))
}

function rosterAccountIds(): string[] {
  return seedAccountIds.length > 0 ? seedAccountIds : storedAccounts.map((account) => account.id)
}

function authStatus(): AuthStatus {
  const accounts = rosterAccountIds().map((id) => ({ id, email: emailFor(id) }))
  const active = accounts.find((account) => account.id === activeAccountId) ?? null
  return {
    configured: seedAccountIds.length === 0 && loadOAuthConfig(oauthSearchDirs()) !== null,
    signedIn: accounts.length > 0,
    ...(active ? { email: active.email } : {}),
    accounts,
    activeAccountId: active?.id ?? null
  }
}

function emailFor(accountId: string): string {
  const stored = storedAccounts.find((account) => account.id === accountId)
  return stored?.tokens.email ?? accountId
}

function serviceAccountsState(): ServiceAccountsState {
  return {
    config: loadOAuthConfig(oauthSearchDirs()),
    accounts: storedAccounts.map((account) => ({
      id: account.id,
      tokens: account.tokens,
      generation: authGenerations.get(account.id) ?? 0
    })),
    activeAccountId,
    ...(testUserData ? { seedAccountIds } : {})
  }
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
  let signedInAccountId: string | undefined
  try {
    const tokens = await signInWithGoogle(config, (url) => shell.openExternal(url))
    const accountId = accountIdForTokens(tokens)
    if (!accountId) throw new Error('Google did not return an email address for this account')
    const refreshed = storedAccounts.some((account) => account.id === accountId)
    storedAccounts = saveAccountTokens(app.getPath('userData'), tokens)
    authGenerations.set(accountId, (authGenerations.get(accountId) ?? 0) + 1)
    signedInAccountId = accountId
    // Adding an account does not activate it: activation goes through the
    // guarded renderer switch, so an OAuth completion that lands while a
    // composer is open can never swap the surface (PR #94 review). The roster
    // update is awaited — the utility's answer names the sessions that
    // actually exist, deferred re-creates included — and its resolved active
    // account (the first sign-in, or the persisted survivor) is adopted.
    await adoptServiceAccounts()
    // Resume the account the flow actually reauthenticated — not the active
    // one, which sign-in no longer changes.
    resumedActions = Number((await service?.internal('resume-auth-failures', accountId)) ?? 0)
    console.log(`[auth] ${refreshed ? 'reconnected' : 'added account'} ${tokens.email ?? accountId}`)
  } catch (error) {
    console.error(`[auth] sign-in failed: ${errorMessage(error)}`)
    throw error
  } finally {
    signInInFlight = false
  }
  return {
    status: authStatus(),
    resumedActions,
    ...(signedInAccountId ? { accountId: signedInAccountId } : {})
  }
}

/**
 * Push the roster to the utility and mirror back the active account it
 * resolved. Waiting on the response is what keeps AuthStatus truthful: the
 * named active account's session exists before anyone reads it.
 */
async function adoptServiceAccounts(): Promise<void> {
  const result = await service?.applyAccounts(serviceAccountsState())
  if (result === null || typeof result === 'string') activeAccountId = result
  service?.noteActiveAccount(activeAccountId)
  reconcilePendingFocus()
  mailNotifier?.setAccounts(authStatus().accounts)
}

/**
 * Remove one account (F18, D3): tokens always go and its session stops; the
 * caller chooses whether the local rows go too (Delete) or stay dormant for
 * a future re-add to resume from stored cursors (Keep).
 */
async function removeAccount(accountId: string, deleteData: boolean): Promise<AuthStatus> {
  const removedIndex = rosterAccountIds().indexOf(accountId)
  if (removedIndex < 0) throw new Error('unknown account')
  cancelActiveSignIn()
  if (seedAccountIds.length > 0) seedAccountIds = seedAccountIds.filter((id) => id !== accountId)
  else storedAccounts = removeAccountTokens(app.getPath('userData'), accountId)
  authGenerations.delete(accountId)
  // Removing the active account activates the next by position; removing a
  // background account leaves the surface alone.
  if (activeAccountId === accountId) {
    const remaining = rosterAccountIds()
    activeAccountId = remaining[removedIndex] ?? remaining[0] ?? null
  }
  await adoptServiceAccounts()
  if (deleteData) await service?.internal('remove-account-data', accountId)
  console.log(`[auth] removed account ${accountId} (${deleteData ? 'deleted' : 'kept'} local data)`)
  return authStatus()
}

async function setActiveAccount(accountId: string): Promise<AuthStatus> {
  if (!rosterAccountIds().includes(accountId)) throw new Error('unknown account')
  // The utility owns the flip: the response guarantees every later read the
  // renderer issues is answered for the new account.
  const result = await service?.internal('set-active-account', accountId)
  activeAccountId = typeof result === 'string' ? result : accountId
  service?.noteActiveAccount(activeAccountId)
  reconcilePendingFocus()
  mailNotifier?.setAccounts(authStatus().accounts)
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
    ...windowChromeOptions(process.platform, themePreference, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--attn-theme=${themePreference}`]
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

function refreshTitleBarOverlay(): void {
  if (process.platform === 'darwin') return
  const options = titleBarOverlayOptions(themePreference, nativeTheme.shouldUseDarkColors)
  for (const win of BrowserWindow.getAllWindows()) win.setTitleBarOverlay(options)
}

function handleNativeThemeUpdated(): void {
  if (themePreference === 'system') refreshTitleBarOverlay()
}

function publishFocus(): void {
  service?.control({
    kind: 'focus',
    focused: BrowserWindow.getAllWindows().some((win) => win.isFocused())
  })
}

function handleServiceEvent(event: ServiceEvent): void {
  if (event.kind === 'mail-changed') {
    broadcast(IPC_CHANNELS.mailChanged, {
      ...(event.serverSearchRequestId ? { serverSearchRequestId: event.serverSearchRequestId } : {}),
      ...(event.reason ? { reason: event.reason } : {})
    })
  } else if (event.kind === 'outbox-changed') broadcast(IPC_CHANNELS.outboxChanged, event.payload)
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
  else if (event.kind === 'accounts-status') broadcast(IPC_CHANNELS.accountsStatusChanged, event.statuses)
  else if (event.kind === 'notification-candidates') {
    mailNotifier?.notify(event.accountId, event.candidates, event.pausedUntil)
  } else if (event.kind === 'token-update') {
    const userDataPath = app.getPath('userData')
    const stored = loadAccounts(userDataPath).find((account) => account.id === event.accountId)
    if (!isCurrentTokenUpdate(authGenerations.get(event.accountId), stored, event)) {
      console.warn(
        `[auth] ignored stale token update for ${event.accountId} (generation ${event.generation})`
      )
      return
    }
    storedAccounts = saveAccountTokens(userDataPath, event.tokens)
    service?.cacheTokens(event.accountId, event.tokens)
  } else if (event.kind === 'log') console[event.level](event.message)
}

async function initialize(): Promise<void> {
  const userDataPath = app.getPath('userData')
  storedAccounts = loadAccounts(userDataPath)
  for (const account of storedAccounts) {
    if (!authGenerations.has(account.id)) authGenerations.set(account.id, 0)
  }
  const ownedNotifier = new MailNotifier(showMainWindow, focusInboxThread)
  mailNotifier = ownedNotifier
  ownedNotifier.start()
  const ownedService = new ServiceSupervisor(join(__dirname, 'service/utility.js'), {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    dbPath: join(userDataPath, 'attn.db'),
    userDataPath,
    downloadsPath: app.getPath('downloads'),
    testMode: Boolean(testUserData),
    ...(testUserData && process.env.ATTN_TEST_SEED ? { testSeed: process.env.ATTN_TEST_SEED } : {}),
    accounts: {
      config: loadOAuthConfig(oauthSearchDirs()),
      accounts: storedAccounts.map((account) => ({
        id: account.id,
        tokens: account.tokens,
        generation: authGenerations.get(account.id) ?? 0
      })),
      activeAccountId: null
    },
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
  // The utility resolved the roster (seed sessions included) and the persisted
  // active pointer; main mirrors that resolution rather than re-deriving it.
  seedAccountIds =
    testUserData && process.env.ATTN_TEST_SEED
      ? ready.accountIds.filter((id) => !storedAccounts.some((account) => account.id === id))
      : []
  activeAccountId = ready.activeAccountId
  ownedService.noteActiveAccount(activeAccountId)
  ownedNotifier.setAccounts(authStatus().accounts)
  console.log(`[db] open at ${join(userDataPath, 'attn.db')} (schema v${ready.schemaVersion})`)
  console.log('[utility] service ready; SQLite ownership transferred')
  themePreference = await ownedService.invoke(IPC_CHANNELS.settingsGetTheme)
  nativeTheme.on('updated', handleNativeThemeUpdated)
  stopIpc = registerIpc({
    service: ownedService,
    authStatus,
    signIn,
    setActiveAccount,
    removeAccount,
    takePendingFocus: takePendingFocusTarget,
    setThemePreference: (preference) => {
      themePreference = preference
      refreshTitleBarOverlay()
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
  nativeTheme.removeListener('updated', handleNativeThemeUpdated)
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
