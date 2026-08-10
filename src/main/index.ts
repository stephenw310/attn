import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { AuthStatus } from '../shared/auth'
import type { SyncState } from '../shared/mail'
import { cancelActiveSignIn, loadOAuthConfig, signInWithGoogle } from './auth/googleAuth'
import { clearTokens, loadTokens, saveTokens } from './auth/tokenStore'
import { type Db, openDatabase, schemaVersion } from './db'
import { countInboxUnread, getConversation, listInboxThreads } from './db/queries'
import { GmailClient } from './gmail/client'
import { runInboxBackfill } from './sync/backfill'

// E2E seam: an isolated userData dir gives each test run a fresh DB and empty
// token store. Must be set before requestSingleInstanceLock() so concurrent
// test apps (distinct dirs) don't share an instance lock.
const testUserData = process.env.ATTN_TEST_USER_DATA
if (testUserData) app.setPath('userData', testUserData)

let db: Db | null = null
let syncState: SyncState = { phase: 'idle' }
let syncRunning = false
let authSessionGeneration = 0

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function setSyncState(s: SyncState): void {
  syncState = s
  broadcast('sync:state', s)
}

function makeClient(generation: number): GmailClient | null {
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  if (!config || !tokens) return null
  return new GmailClient(config, tokens, (t) => {
    if (generation === authSessionGeneration) saveTokens(app.getPath('userData'), t)
  })
}

function currentAccountId(): string | null {
  return loadTokens(app.getPath('userData'))?.email ?? null
}

function startSync(): void {
  if (!db || syncRunning) return
  const generation = authSessionGeneration
  const client = makeClient(generation)
  if (!client) return
  syncRunning = true
  setSyncState({ phase: 'syncing', threadsDone: 0 })
  console.log('[sync] inbox backfill started')
  void runInboxBackfill(db, client, {
    onProgress: (n) => {
      if (generation !== authSessionGeneration) return
      setSyncState({ phase: 'syncing', threadsDone: n })
      broadcast('mail:changed')
    },
    onDone: (accountId, count) => {
      syncRunning = false
      if (generation !== authSessionGeneration) {
        if (authStatus().signedIn) startSync()
        return
      }
      setSyncState({ phase: 'idle' })
      broadcast('mail:changed')
      console.log(`[sync] backfill done: ${count} inbox threads for ${accountId}`)
    },
    onError: (message) => {
      syncRunning = false
      if (generation !== authSessionGeneration) {
        if (authStatus().signedIn) startSync()
        return
      }
      setSyncState({ phase: 'error', message })
      console.error(`[sync] failed: ${message}`)
    }
  })
}

function oauthSearchDirs(): string[] {
  // Under e2e, only the isolated dir — a developer's real oauth.config.json in
  // the project root must never leak into test runs.
  if (testUserData) return [app.getPath('userData')]
  // Project root in dev; userData for a packaged build.
  return [app.getAppPath(), app.getPath('userData')]
}

function authStatus(): AuthStatus {
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  return { configured: config !== null, signedIn: tokens !== null, email: tokens?.email }
}

let signInInFlight = false

function registerIpc(): void {
  ipcMain.handle('auth:getStatus', () => authStatus())
  ipcMain.handle('auth:signIn', async () => {
    const config = loadOAuthConfig(oauthSearchDirs())
    if (!config) return authStatus()
    // A retry click aborts the previous pending flow instead of being ignored.
    if (signInInFlight) cancelActiveSignIn()
    signInInFlight = true
    try {
      const tokens = await signInWithGoogle(config, (url) => shell.openExternal(url))
      authSessionGeneration++
      saveTokens(app.getPath('userData'), tokens)
      console.log(`[auth] signed in as ${tokens.email ?? 'unknown'}`)
      startSync()
    } catch (e) {
      console.error('[auth] sign-in failed:', e instanceof Error ? e.message : e)
      throw e
    } finally {
      signInInFlight = false
    }
    return authStatus()
  })

  ipcMain.handle('auth:signOut', () => {
    cancelActiveSignIn()
    authSessionGeneration++
    clearTokens(app.getPath('userData'))
    // A stale backfill may finish caching locally, but its generation can no
    // longer persist refreshed tokens or publish state for the signed-out user.
    setSyncState({ phase: 'idle' })
    console.log('[auth] signed out')
    return authStatus()
  })

  ipcMain.handle('sync:getState', () => syncState)
  ipcMain.handle('mail:listThreads', () => {
    if (!db) return []
    const account = currentAccountId()
    return account ? listInboxThreads(db, account) : []
  })
  ipcMain.handle('mail:getUnreadCount', () => {
    if (!db) return 0
    const account = currentAccountId()
    return account ? countInboxUnread(db, account) : 0
  })
  ipcMain.handle('mail:getConversation', (_e, threadId: unknown) => {
    if (!db || typeof threadId !== 'string') return null
    const account = currentAccountId()
    return account ? getConversation(db, account, threadId) : null
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // All external links open in the system browser, never in-app (SPEC §6).
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    const dbPath = join(app.getPath('userData'), 'attn.db')
    db = openDatabase(dbPath)
    console.log(`[db] open at ${dbPath} (schema v${schemaVersion(db)})`)

    registerIpc()
    createWindow()
    if (authStatus().signedIn) startSync()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // F16 (tray/background mode) lands at M1; the M0 skeleton quits normally.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    db?.close()
    db = null
  })
}
