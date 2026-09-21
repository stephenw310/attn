import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, powerMonitor, safeStorage, shell } from 'electron'
import { type AiSettings, validateAiSettingUpdate } from '../shared/ai'
import {
  type AppInfo,
  type DistributionKind,
  shouldConstructUpdater,
  UPDATE_STATE_IDLE,
  type UpdateState
} from '../shared/distribution'
import { errorMessage } from '../shared/error'
import { type BroadcastChannel, type BroadcastChannels, IPC_CHANNELS } from '../shared/ipc'
import { type DefaultMailClient, parseMailtoUrl } from '../shared/mailto'
import type { AppSettingUpdate } from '../shared/settings'
import type { PaletteId, ThemePreference } from '../shared/theme'
import { AccountRoster } from './accountRoster'
import { AiKeyStore, type SecretCipher, TYPESAFE_KEY_FILE } from './ai/keyStore'
import { AiManager } from './ai/manager'
import { appIconPath, applyAppIcon } from './appIcon'
import { oauthConfigSearchDirs } from './auth/configPaths'
import { cancelActiveSignIn, loadOAuthConfig, type OAuthConfig, signInWithGoogle } from './auth/googleAuth'
import {
  applyMenuBarIcon,
  attachBackgroundWindow,
  type BackgroundEffects,
  initializeBackground,
  showBackgroundWindow,
  showMainWindow
} from './background'
import { applyLoginItemSetting } from './backgroundSettings'
import { CURRENT_SCHEMA_VERSION } from './db/schema'
import { isOpenableExternalUrl } from './externalLinks'
import { registerIpc, registerWindowEvents } from './ipc'
import {
  acknowledgePendingCompose,
  mailtoUrlFromArgv,
  type PendingCompose,
  takePendingCompose
} from './mailtoLink'
import { acknowledgePendingFocus, MailNotifier, type PendingFocus, takePendingFocus } from './notify'
import {
  DEFAULT_REMOTE_IMAGE_POLICY,
  MailFrameRegistry,
  type RemoteImagePolicy,
  shouldBlockMailFrameRequest
} from './remoteImages'
import { SERVICE_PROTOCOL_VERSION, type ServiceEvent, type ServiceReady } from './service/protocol'
import { ServiceSupervisor } from './service/supervisor'
import { TestSeams } from './testIpc'
import { readDistributionMetadata } from './update/distribution'
import { createElectronUpdaterFeed } from './update/electronUpdaterFeed'
import { AppUpdater } from './update/updater'
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
let stopIpc: (() => void) | null = null
let pendingFocus: PendingFocus | null = null
// F16: a `mailto:` link waiting for a composer. Unlike a focus target it is
// not bound to an account — whichever account is on screen writes the mail.
let pendingCompose: PendingCompose | null = null
let teardownPromise: Promise<void> | null = null
let mailNotifier: MailNotifier | null = null
let themePreference: ThemePreference = 'system'
let palettePreference: PaletteId = 'matcha'
// The OAuth client from oauth.config.json, loaded at boot and on sign-in.
let oauthConfig: OAuthConfig | null = null
// T33: the live remote-image policy (pushed by the utility) and the reader's
// registered mail frames, consulted by the request filter in createWindow.
let remoteImagePolicy: RemoteImagePolicy = DEFAULT_REMOTE_IMAGE_POLICY
const mailFrames = new MailFrameRegistry()
// T39: constructed only for packaged release builds outside the test seam.
let appUpdater: AppUpdater | null = null
// The opened database's schema, from the utility's ready handshake: updates
// must match it exactly, and a manual dogfood upgrade would change it.
let openedSchemaVersion: number | null = null
// Test-only: lets the seeded harness stage a stored update state for the
// renderer's mount-time read; always null outside ATTN_TEST_USER_DATA.
let updateStateOverride: UpdateState | null = null
// Test-only: stands in for the OS `mailto:` registration, which the suite must
// never touch. Always null outside ATTN_TEST_USER_DATA.
let defaultMailClientOverride: DefaultMailClient | null = null
// B28: in-flight pre-quit composer checkpoints, keyed by request id.
const pendingComposerCheckpoints = new Map<number, () => void>()
let composerCheckpointId = 0
const COMPOSER_CHECKPOINT_TIMEOUT_MS = 2_000

const testSeams = new TestSeams(Boolean(testUserData), {
  service: () => service,
  focusInboxThread: (threadId, accountId) => {
    const owner = accountId ?? roster.activeId()
    if (owner) focusInboxThread(owner, threadId)
  },
  setUpdateStateOverride: (state) => {
    updateStateOverride = state
  },
  openMailto: (url) => handleMailtoUrl(url),
  setDefaultMailClientOverride: (state) => {
    defaultMailClientOverride = state
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
 * Resolve the pending focus target for the account on screen. Resolving never
 * consumes: a `switch` ask stays pending for the remounted tree, and even a
 * `focus` answer stays pending until the tree that accepted it acknowledges —
 * a pull whose delivery dies in a torn-down subscription during an account
 * remount must not lose the click (T32 regression). Only an expired or absent
 * target clears here.
 */
function takePendingFocusTarget(): ReturnType<typeof takePendingFocus> {
  const target = takePendingFocus(pendingFocus, roster.activeId())
  if (target === null) pendingFocus = null
  return target
}

function acknowledgeFocusTarget(id: number): void {
  pendingFocus = acknowledgePendingFocus(pendingFocus, id)
}

/**
 * The one entry point for a `mailto:` link, whatever route the OS used: the
 * macOS `open-url` event, a second instance's command line, or this process's
 * own launch arguments (F16). The window comes up either way — a link the
 * parser refuses still raises Attn rather than looking like a dead click.
 *
 * Nothing is sent when no window exists yet: the renderer pulls the pending
 * request when it mounts, which is exactly the cold-start case.
 */
function handleMailtoUrl(url: string): void {
  const prefill = parseMailtoUrl(url)
  if (!prefill) {
    // The URL itself is untrusted content; only its length is logged.
    console.warn(`[mailto] ignored an unusable link (${url.length} characters)`)
    showMainWindow()
    return
  }
  pendingCompose = { prefill, at: Date.now() }
  const win = showMainWindow()
  console.log(
    `[mailto] compose requested for ${prefill.to.length} recipients (window ${win ? 'available' : 'pending'})`
  )
  win?.webContents.send(IPC_CHANNELS.mailComposeAvailable)
}

function takePendingComposeTarget(): ReturnType<typeof takePendingCompose> {
  const target = takePendingCompose(pendingCompose)
  if (target === null) pendingCompose = null
  return target
}

function acknowledgeComposeTarget(id: number): void {
  pendingCompose = acknowledgePendingCompose(pendingCompose, id)
}

/**
 * Attn never claims the `mailto:` handler on its own — a mail client that
 * takes the registration at startup is a mail client the user did not choose.
 * The Settings row and its palette command are the only callers, and an
 * unpackaged or test build reports the registration unsupported so no suite
 * can rewrite a developer's default mail app.
 */
function defaultMailClient(): DefaultMailClient {
  if (defaultMailClientOverride) return defaultMailClientOverride
  if (!app.isPackaged || testUserData) return { supported: false, isDefault: false }
  return { supported: true, isDefault: app.isDefaultProtocolClient('mailto') }
}

function claimDefaultMailClient(): DefaultMailClient {
  const current = defaultMailClient()
  if (!current.supported) return current
  if (defaultMailClientOverride) {
    defaultMailClientOverride = { ...defaultMailClientOverride, isDefault: true }
    return defaultMailClientOverride
  }
  app.setAsDefaultProtocolClient('mailto')
  return { supported: true, isDefault: app.isDefaultProtocolClient('mailto') }
}

/**
 * Register a mounted mail frame (T33). The sender comes from the local store
 * via the utility — never from markup — and the answer tells the reader
 * whether this message's images will load, so the banner needs no second
 * policy source.
 */
async function registerMailFrame(
  nonce: string,
  messageId: string,
  allowOnce: boolean
): Promise<{ blocked: boolean; imagesAllowed: boolean }> {
  const resolved = await service?.internal('resolve-message-sender', messageId)
  const frame = { messageId, sender: typeof resolved === 'string' ? resolved : null, allowOnce }
  mailFrames.register(nonce, frame)
  return {
    blocked: remoteImagePolicy.blocked,
    imagesAllowed: !shouldBlockMailFrameRequest(remoteImagePolicy, frame)
  }
}

/**
 * An active-account change consumes or drops the pending focus target: it
 * survives only when it names the account now active (the notification-driven
 * switch completing). A manual switch elsewhere discards it rather than
 * bouncing the user to the notified account later.
 */
function reconcilePendingFocus(): void {
  if (pendingFocus && pendingFocus.accountId !== roster.activeId()) pendingFocus = null
}

function oauthSearchDirs(): string[] {
  return oauthConfigSearchDirs(app.getAppPath(), app.getPath('userData'), Boolean(testUserData))
}

/**
 * The OAuth client is read from up to three directories, so it is cached
 * rather than re-read synchronously by every status read and roster push.
 * A sign-in reloads it first, which is when an operator who just dropped
 * `oauth.config.json` in place clicks.
 */
function reloadOAuthConfig(): OAuthConfig | null {
  oauthConfig = loadOAuthConfig(oauthSearchDirs())
  return oauthConfig
}

// The roster owns every account transition (F15/F18); this file boots and
// tears down the app around it (R11).
const roster = new AccountRoster({
  userDataPath: () => app.getPath('userData'),
  service: () => service,
  oauthConfig: () => oauthConfig,
  reloadOAuthConfig,
  signIn: (config) => signInWithGoogle(config, (url) => shell.openExternal(url)),
  cancelSignIn: cancelActiveSignIn,
  testMode: Boolean(testUserData),
  onAdopted: (status) => {
    reconcilePendingFocus()
    mailNotifier?.setAccounts(status.accounts)
  }
})

function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const shouldShow = options.show ?? true
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    icon: appIconPath(palettePreference),
    show: false,
    autoHideMenuBar: true,
    ...windowChromeOptions(process.platform, themePreference, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--attn-theme=${themePreference}`,
        `--attn-palette=${palettePreference}`,
        ...(testUserData ? ['--attn-test-mode'] : [])
      ]
    }
  })
  // T33 enforcement point: the same request layer that strips CORP below.
  // Only mail frames (about:srcdoc) are filtered — the app shell and other
  // requests are untouched, and with blocking off the behavior is identical
  // to today (decision #5's default load stands). Every network-capable type
  // is covered, not just images: sanitized mail keeps its <style>, whose
  // @import/@font-face/url() would otherwise ping the sender through
  // stylesheet, font, and media requests (PR #101 review).
  // No `types` filter: every resource type a frame can request is covered,
  // including ones Electron's filter enum cannot name ('other').
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (details.frame?.url !== 'about:srcdoc') {
        callback({})
        return
      }
      callback({
        cancel: shouldBlockMailFrameRequest(remoteImagePolicy, mailFrames.get(details.frame.name))
      })
    }
  )
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
    if (shouldShow) showBackgroundWindow(win)
  })
  win.on('focus', publishFocus)
  win.on('blur', publishFocus)
  attachBackgroundWindow(win)
  registerWindowEvents(win)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  // T33: a reload or a renderer crash takes every mounted mail frame with it
  // without unregistering; stale entries (an `allowOnce` grant among them)
  // must not outlive the frames they described.
  win.webContents.on('render-process-gone', () => mailFrames.clear())
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) mailFrames.clear()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Mail bodies are untrusted, so main decides which schemes may reach the
    // OS; everything else is dropped rather than handed to a protocol handler.
    if (isOpenableExternalUrl(url)) void shell.openExternal(url)
    else console.warn(`[window] refused to open a ${url.split(':', 1)[0] || 'scheme-less'} link`)
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

/**
 * The version About shows and the updater compares against. A packaged app
 * reads its own package.json through `app.getVersion()`; an unpackaged one
 * (electron-vite dev, the e2e harness) is launched from `out/main`, where
 * Electron finds no package.json and answers with its own version instead,
 * so the project's package.json two levels up is read directly.
 */
function runningVersion(): string {
  if (app.isPackaged) return app.getVersion()
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version.length > 0) return manifest.version
  } catch {
    // fall through to Electron's answer
  }
  return app.getVersion()
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
  } else if (event.kind === 'remote-images') {
    remoteImagePolicy = { blocked: event.blocked, allowedSenders: new Set(event.allowedSenders) }
    // Mounted mail frames re-register on this signal so a policy change
    // reaches messages that are already open (PR #101 review).
    broadcast(IPC_CHANNELS.mailRemoteImagesChanged, undefined)
  } else if (event.kind === 'badge') mailNotifier?.updateBadge(event.unreadCount)
  else if (event.kind === 'accounts-status') broadcast(IPC_CHANNELS.accountsStatusChanged, event.statuses)
  else if (event.kind === 'notification-candidates') {
    mailNotifier?.notify(event.accountId, event.candidates, event.pausedUntil)
  } else if (event.kind === 'token-update') {
    if (roster.applyTokenUpdate(event)) service?.cacheTokens(event.accountId, event.tokens)
  } else if (event.kind === 'log') console[event.level](event.message)
}

async function initialize(): Promise<void> {
  const userDataPath = app.getPath('userData')
  reloadOAuthConfig()
  roster.loadStoredAccounts()
  const ownedNotifier = new MailNotifier(showMainWindow, focusInboxThread)
  mailNotifier = ownedNotifier
  ownedNotifier.start()
  // Under the e2e seam the container has no OS keyring, so a reversible
  // stand-in keeps the key-custody flows testable; production always uses
  // safeStorage and still refuses plaintext storage when it is unavailable.
  const secretCipher: SecretCipher = testUserData
    ? {
        isAvailable: () => true,
        encryptString: (text) => Buffer.from(`test:${Buffer.from(text, 'utf8').toString('base64')}`),
        decryptString: (data) => {
          const stored = data.toString('utf8')
          if (!stored.startsWith('test:')) throw new Error('not test ciphertext')
          return Buffer.from(stored.slice(5), 'base64').toString('utf8')
        }
      }
    : {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (text) => safeStorage.encryptString(text),
        decryptString: (data) => safeStorage.decryptString(data)
      }
  const aiKeyStore = new AiKeyStore(userDataPath, secretCipher)
  // Smart splits use their own TypeSafe key in a second file, so removing one
  // key leaves the other feature working.
  const triageKeyStore = new AiKeyStore(userDataPath, secretCipher, TYPESAFE_KEY_FILE)
  const ownedService = new ServiceSupervisor(join(__dirname, 'service/utility.js'), {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    dbPath: join(userDataPath, 'attn.db'),
    userDataPath,
    downloadsPath: app.getPath('downloads'),
    testMode: Boolean(testUserData),
    ...(testUserData && process.env.ATTN_TEST_SEED ? { testSeed: process.env.ATTN_TEST_SEED } : {}),
    accounts: { ...roster.serviceAccountsState(), activeAccountId: null },
    focused: false,
    // Relayed at startup so the classifier (Phase 3) has the key without a
    // round trip; the utility keeps it in memory only.
    triageKey: triageKeyStore.load()
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
  roster.adoptReady(ready, Boolean(testUserData && process.env.ATTN_TEST_SEED))
  ownedNotifier.setAccounts(roster.authStatus().accounts)
  ownedNotifier.setBadgeEnabled(ready.background.unreadBadgeEnabled)
  openedSchemaVersion = ready.schemaVersion
  console.log(`[db] open at ${join(userDataPath, 'attn.db')} (schema v${ready.schemaVersion})`)
  console.log('[utility] service ready; SQLite ownership transferred')
  themePreference = await ownedService.invoke(IPC_CHANNELS.settingsGetTheme)
  palettePreference = (await ownedService.invoke(IPC_CHANNELS.settingsGetAll)).palette
  applyAppIcon(palettePreference)
  nativeTheme.on('updated', handleNativeThemeUpdated)
  const backgroundEffects: BackgroundEffects = {
    markLoginItemRegistered: () =>
      void service?.internal('mark-login-item-registered').catch((error) => {
        console.error(`[background] could not save login item state: ${errorMessage(error)}`)
      }),
    setNotificationPausedUntil: (pausedUntil) =>
      void service?.internal('set-notification-pause', pausedUntil).catch((error) => {
        console.error(`[notifications] could not save pause setting: ${errorMessage(error)}`)
      })
  }
  const applySettingEffects = (update: AppSettingUpdate): void => {
    if (update.key === 'palette') {
      palettePreference = update.value
      applyAppIcon(palettePreference)
    }
    // Storage already happened in the utility; these are the OS-side effects
    // main owns (F15). The login item updates on every change, deliberately
    // bypassing the one-time boot registration guard.
    if (update.key === 'launchAtLogin') {
      applyLoginItemSetting(update.value, process.platform, app, backgroundEffects)
    } else if (update.key === 'menuBarIcon') {
      applyMenuBarIcon(update.value, backgroundEffects)
    } else if (update.key === 'unreadBadgeEnabled') {
      ownedNotifier.setBadgeEnabled(update.value)
    }
  }
  const ownedAiManager = new AiManager({
    keyStore: aiKeyStore,
    readSettings: () => ownedService.invoke(IPC_CHANNELS.aiGetSettings),
    emit: (event) => broadcast(IPC_CHANNELS.aiStreamEvent, event),
    // Under the seam the scripted provider replaces the network entirely; the
    // manager runs its one production path either way (T36).
    ...(testUserData ? { fetchFn: testSeams.aiTransport.fetch } : {})
  })
  const aiSettingsSnapshot = async (): Promise<AiSettings> => ({
    ...(await ownedService.invoke(IPC_CHANNELS.aiGetSettings)),
    keyPresent: aiKeyStore.present(),
    keyPreview: aiKeyStore.preview(),
    triageKeyPresent: triageKeyStore.present(),
    triageKeyPreview: triageKeyStore.preview()
  })
  // T39: only an explicit, packaged release build constructs an updater —
  // personal, dev, and seeded builds make zero feed requests (§6 Packaging).
  const distribution = app.isPackaged ? readDistributionMetadata(process.resourcesPath) : null
  const version = runningVersion()
  // What the About surface says about this build (F15): unpackaged is a
  // development build; packaged with missing or personal metadata is
  // personal; only explicit release metadata is a release.
  const distributionKind: DistributionKind = !app.isPackaged
    ? 'development'
    : (distribution?.mode ?? 'personal')
  const appInfo = (): AppInfo => ({
    version,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    distribution: distributionKind,
    feed: distribution?.feed ? `${distribution.feed.owner}/${distribution.feed.repo}` : null,
    updaterActive: appUpdater !== null
  })
  if (shouldConstructUpdater(distribution, app.isPackaged, Boolean(testUserData))) {
    appUpdater = new AppUpdater({
      feed: createElectronUpdaterFeed(distribution),
      currentVersion: version,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      localSchemaVersion: () => openedSchemaVersion,
      onStateChange: (state) => broadcast(IPC_CHANNELS.updateState, state)
    })
    appUpdater.start()
  }
  stopIpc = registerIpc({
    service: ownedService,
    authStatus: () => roster.authStatus(),
    signIn: () => roster.signIn(),
    setActiveAccount: (accountId) => roster.setActiveAccount(accountId),
    removeAccount: (accountId, deleteData) => roster.removeAccount(accountId, deleteData),
    reorderAccounts: (accountIds) => roster.reorderAccounts(accountIds),
    takePendingFocus: takePendingFocusTarget,
    acknowledgePendingFocus: acknowledgeFocusTarget,
    takePendingCompose: takePendingComposeTarget,
    acknowledgePendingCompose: acknowledgeComposeTarget,
    defaultMailClient: { get: defaultMailClient, set: claimDefaultMailClient },
    acknowledgeComposerCheckpoint: (requestId) => pendingComposerCheckpoints.get(requestId)?.(),
    applySettingEffects,
    appInfo,
    update: {
      getState: () => updateStateOverride ?? appUpdater?.state() ?? UPDATE_STATE_IDLE,
      check: () => appUpdater?.checkNow() ?? Promise.resolve(updateStateOverride ?? UPDATE_STATE_IDLE),
      restart: () => appUpdater?.restartToApply() ?? Promise.resolve(false)
    },
    splits: {
      // The utility owns the counts and the consent flag; the TypeSafe key
      // never leaves main, so only main can say whether one is stored.
      getTriageStatus: async () => ({
        ...(await ownedService.invoke(IPC_CHANNELS.splitsGetTriageStatus)),
        keyPresent: triageKeyStore.present()
      })
    },
    ai: {
      getSettings: aiSettingsSnapshot,
      setSetting: async (key, value) => {
        const update = validateAiSettingUpdate(key, value)
        const stored = await ownedService.invoke(IPC_CHANNELS.aiSetSetting, update.key, update.value)
        // Disabling cancels in-flight work and drops late responses (F17):
        // the master switch stops everything, the autocomplete switch only
        // its own requests.
        if (update.key === 'enabled' && update.value === false) ownedAiManager.cancelAll()
        else if (update.key === 'autocompleteEnabled' && update.value === false) {
          ownedAiManager.cancelAll('autocomplete')
        }
        return {
          ...stored,
          keyPresent: aiKeyStore.present(),
          keyPreview: aiKeyStore.preview(),
          triageKeyPresent: triageKeyStore.present(),
          triageKeyPreview: triageKeyStore.preview()
        }
      },
      setKey: async (key) => {
        aiKeyStore.save(key)
        return aiSettingsSnapshot()
      },
      deleteKey: async () => {
        // Removing the key cancels in-flight work and disables both features
        // (F17); OAuth credentials are untouched by design.
        aiKeyStore.delete()
        ownedAiManager.cancelAll()
        await ownedService.invoke(IPC_CHANNELS.aiSetSetting, 'enabled', false)
        await ownedService.invoke(IPC_CHANNELS.aiSetSetting, 'autocompleteEnabled', false)
        return aiSettingsSnapshot()
      },
      setTriageKey: async (key) => {
        // Save first: a refused save (no OS encryption) must not relay a key
        // the app cannot keep. The key is never logged on either side.
        triageKeyStore.save(key)
        await ownedService.applyTriageKey(key)
        return aiSettingsSnapshot()
      },
      deleteTriageKey: async () => {
        // Removing the TypeSafe key withdraws smart-splits consent and leaves
        // AI writing and OAuth credentials untouched by design.
        triageKeyStore.delete()
        await ownedService.applyTriageKey(null)
        await ownedService.invoke(IPC_CHANNELS.aiSetSetting, 'triageEnabled', false)
        return aiSettingsSnapshot()
      },
      generate: (request) => ownedAiManager.generate(request),
      cancel: (requestId) => ownedAiManager.cancel(requestId)
    },
    registerMailFrame,
    unregisterMailFrame: (nonce) => mailFrames.unregister(nonce),
    setThemePreference: (preference) => {
      themePreference = preference
      refreshTitleBarOverlay()
    },
    pickAttachmentPaths: testUserData ? async () => testSeams.takeAttachmentPickerPaths() : undefined
  })
  powerMonitor.on('resume', refreshSchedulersAfterResume)
  const { startHidden } = initializeBackground(ready.background, backgroundEffects, createWindow)
  createWindow({ show: !startHidden })
  testSeams.register()
  app.on('activate', () => showMainWindow())
}

/**
 * Ask every window to commit its open composer and wait for the answers
 * (B28). This runs on `before-quit`, while the documents are still alive: a
 * renderer that serializes its editor during unload cannot load the `data:`
 * URLs an inline image needs, so the checkpoint has to happen here rather than
 * in a `pagehide` handler. The wait is bounded — a wedged renderer delays the
 * quit by at most `COMPOSER_CHECKPOINT_TIMEOUT_MS`, and the preload answers
 * immediately when no composer is mounted.
 */
function checkpointComposers(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.webContents.isDestroyed())
  if (windows.length === 0) return Promise.resolve()
  const requestId = ++composerCheckpointId
  return new Promise<void>((resolve) => {
    let remaining = windows.length
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (): void => {
      if (!pendingComposerCheckpoints.delete(requestId)) return
      if (timer !== null) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      console.warn('[composer] checkpoint timed out before quit')
      settle()
    }, COMPOSER_CHECKPOINT_TIMEOUT_MS)
    pendingComposerCheckpoints.set(requestId, () => {
      remaining -= 1
      if (remaining <= 0) settle()
    })
    for (const win of windows) {
      win.webContents.send(IPC_CHANNELS.draftCheckpointRequest, { requestId })
    }
  })
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
  appUpdater?.stop()
  appUpdater = null
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

let quitPrepared = false
let quitPreparation: Promise<void> | null = null

/**
 * Everything a quit needs before the process may go: the composers checkpoint
 * while their documents are alive (B28), a ready update is re-validated and
 * staged so this quit applies it (T39 — the ordinary quit and the explicit
 * restart both pass through here; the restart claims the update before its
 * installer calls app.quit(), so it skips the staging), and then the workers
 * stop. Runs once; a second caller joins the first.
 */
function prepareQuit(): Promise<void> {
  if (quitPreparation) return quitPreparation
  quitPreparation = (async () => {
    await checkpointComposers().catch(() => {})
    await appUpdater?.installOnQuit().catch(() => {})
    await teardown()
  })().finally(() => {
    quitPrepared = true
  })
  return quitPreparation
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('before-quit', (event) => {
    if (quitPrepared) return
    event.preventDefault()
    // A preparation already under way (a second quit, or the explicit
    // restart's) quits on its own when it finishes.
    if (quitPreparation) return
    void prepareQuit().finally(() => app.quit())
  })
  // F16: macOS delivers a `mailto:` link through this event, and can fire it
  // before `whenReady` on a cold start — registering it here rather than in
  // `initialize` is what keeps the launching link from being dropped.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (/^mailto:/i.test(url)) handleMailtoUrl(url)
  })
  app.on('second-instance', (_event, argv) => {
    // Windows and Linux hand the link to the second instance's command line.
    const url = mailtoUrlFromArgv(argv)
    if (url) handleMailtoUrl(url)
    else showMainWindow()
  })
  app.whenReady().then(async () => {
    try {
      // A cold start from a link on Windows and Linux: the request is parked
      // before the window exists, and the mounting renderer pulls it.
      const launchUrl = mailtoUrlFromArgv(process.argv)
      if (launchUrl) handleMailtoUrl(launchUrl)
      await initialize()
    } catch (error) {
      console.error(`[boot] failed: ${errorMessage(error)}`)
      void teardown().finally(() => app.exit(1))
    }
  })
  app.on('window-all-closed', () => {})
  app.on('will-quit', () => void teardown())
}
