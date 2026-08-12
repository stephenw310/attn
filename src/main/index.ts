import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { AuthStatus } from '../shared/auth'
import type { DownloadAttachmentRequest, DownloadAttachmentResult, SyncState } from '../shared/mail'
import { clearUndo, isTriageAction, pendingActionCount, performTriage, undoLast } from './actions'
import { ActionExecutor } from './actions/executor'
import { writeAttachment } from './attachments'
import { oauthConfigSearchDirs } from './auth/configPaths'
import { cancelActiveSignIn, loadOAuthConfig, signInWithGoogle } from './auth/googleAuth'
import { clearTokens, loadTokens, saveTokens } from './auth/tokenStore'
import { attachBackgroundWindow, initializeBackground, showMainWindow } from './background'
import { type Db, openDatabase, schemaVersion } from './db'
import {
  countInboxUnread,
  getConversation,
  getInlineAttachmentData,
  listInboxThreads,
  listUserLabels
} from './db/queries'
import { loadSeed } from './dev/seed'
import { GmailClient } from './gmail/client'
import { GmailMailProvider } from './gmail/provider'
import { runInboxBackfill } from './sync/backfill'

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
let syncState: SyncState = { phase: 'idle' }
let syncRunning = false
let authSessionGeneration = 0
let seedAccountId: string | null = null
let actionExecutor: ActionExecutor | null = null

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

function makeProvider(): GmailMailProvider | null {
  if (seedAccountId) return null
  const client = makeClient(authSessionGeneration)
  return client ? new GmailMailProvider(client) : null
}

function currentAccountId(): string | null {
  return seedAccountId ?? loadTokens(app.getPath('userData'))?.email ?? null
}

function startSync(): void {
  if (!db || syncRunning || seedAccountId) return
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
        if (authStatus().signedIn) void resumeOnlineWork()
        return
      }
      setSyncState({ phase: 'idle' })
      broadcast('mail:changed')
      console.log(`[sync] backfill done: ${count} inbox threads for ${accountId}`)
    },
    onError: (message) => {
      syncRunning = false
      if (generation !== authSessionGeneration) {
        if (authStatus().signedIn) void resumeOnlineWork()
        return
      }
      setSyncState({ phase: 'error', message })
      console.error(`[sync] failed: ${message}`)
    }
  })
}

async function resumeOnlineWork(): Promise<void> {
  await actionExecutor?.trigger()
  // A sign-out/account switch can make an active drain finish early. A second
  // pass picks up the newly active account before its server snapshot starts.
  await actionExecutor?.trigger()
  if (authStatus().signedIn) startSync()
}

function oauthSearchDirs(): string[] {
  // Under e2e, only the isolated dir — a developer's real oauth.config.json in
  // either checkout must never leak into test runs.
  return oauthConfigSearchDirs(app.getAppPath(), app.getPath('userData'), Boolean(testUserData))
}

function authStatus(): AuthStatus {
  if (seedAccountId) return { configured: false, signedIn: true, email: seedAccountId }
  const config = loadOAuthConfig(oauthSearchDirs())
  const tokens = loadTokens(app.getPath('userData'))
  return { configured: config !== null, signedIn: tokens !== null, email: tokens?.email }
}

function isDownloadAttachmentRequest(value: unknown): value is DownloadAttachmentRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DownloadAttachmentRequest>
  return (
    typeof candidate.messageId === 'string' &&
    candidate.messageId.length > 0 &&
    typeof candidate.attachmentId === 'string' &&
    candidate.attachmentId.length > 0 &&
    typeof candidate.filename === 'string' &&
    candidate.filename.length > 0
  )
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
      void resumeOnlineWork()
    } catch (e) {
      console.error('[auth] sign-in failed:', e instanceof Error ? e.message : e)
      throw e
    } finally {
      signInInFlight = false
    }
    return authStatus()
  })

  ipcMain.handle('auth:signOut', () => {
    const account = currentAccountId()
    cancelActiveSignIn()
    authSessionGeneration++
    seedAccountId = null
    clearTokens(app.getPath('userData'))
    clearUndo(account ?? undefined)
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
  ipcMain.handle('mail:listLabels', () => {
    if (!db) return []
    const account = currentAccountId()
    return account ? listUserLabels(db, account) : []
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
  ipcMain.handle(
    'mail:downloadAttachment',
    async (_e, request: unknown): Promise<DownloadAttachmentResult> => {
      if (!isDownloadAttachmentRequest(request)) return { error: 'Invalid attachment' }
      const account = currentAccountId()
      const inlineData =
        db && account ? getInlineAttachmentData(db, account, request.messageId, request.attachmentId) : null
      const client = inlineData === null && !seedAccountId ? makeClient(authSessionGeneration) : null
      if (inlineData === null && !client) return { error: 'Attachments download when signed in' }
      try {
        const data =
          inlineData ??
          (
            await client?.get<{ data?: string }>(
              `/messages/${request.messageId}/attachments/${request.attachmentId}`
            )
          )?.data
        if (typeof data !== 'string') return { error: 'Attachment data was unavailable' }
        const path = await writeAttachment(
          app.getPath('downloads'),
          request.filename,
          Buffer.from(data, 'base64url')
        )
        shell.showItemInFolder(path)
        return { path }
      } catch (error) {
        console.error(
          `[attachment] download failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return { error: 'Could not download attachment' }
      }
    }
  )
  ipcMain.handle('mail:triage', (_e, action: unknown) => {
    if (!db) throw new Error('database unavailable')
    if (!isTriageAction(action)) throw new Error('invalid triage action')
    const account = currentAccountId()
    if (!account) throw new Error('not signed in')
    const result = performTriage(db, account, action)
    broadcast('mail:changed')
    void actionExecutor?.trigger()
    return result
  })
  ipcMain.handle('mail:markReadOnOpen', (_e, threadId: unknown) => {
    if (!db || typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('invalid thread id')
    }
    const account = currentAccountId()
    if (!account) throw new Error('not signed in')
    performTriage(db, account, { kind: 'markUnread', threadIds: [threadId], on: false }, false)
    broadcast('mail:changed')
    void actionExecutor?.trigger()
  })
  ipcMain.handle('mail:undo', () => {
    if (!db) return null
    const account = currentAccountId()
    if (!account) return null
    const result = undoLast(db, account)
    if (result) {
      broadcast('mail:changed')
      void actionExecutor?.trigger()
    }
    return result
  })
  ipcMain.handle('mail:getPendingActionCount', () => {
    if (!db) return 0
    const account = currentAccountId()
    return account ? pendingActionCount(db, account) : 0
  })
}

function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const shouldShow = options.show ?? true
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

  win.on('ready-to-show', () => {
    if (shouldShow) win.show()
  })
  attachBackgroundWindow(win)

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
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(() => {
    const dbPath = join(app.getPath('userData'), 'attn.db')
    db = openDatabase(dbPath)
    console.log(`[db] open at ${dbPath} (schema v${schemaVersion(db)})`)
    const seedPath = testUserData ? process.env.ATTN_TEST_SEED : undefined
    if (seedPath) {
      try {
        const existing = db.prepare('SELECT id FROM accounts ORDER BY created_at LIMIT 1').get() as
          | { id: string }
          | undefined
        seedAccountId = existing?.id ?? loadSeed(db, seedPath)
      } catch (error) {
        console.error(`[seed] failed: ${error instanceof Error ? error.message : String(error)}`)
        app.exit(1)
        return
      }
    }

    registerIpc()
    actionExecutor = new ActionExecutor(db, currentAccountId, makeProvider, () => broadcast('mail:changed'))
    const { startHidden } = initializeBackground(db, createWindow)
    createWindow({ show: !startHidden })
    if (authStatus().signedIn) void resumeOnlineWork()
    app.on('activate', () => showMainWindow())
  })

  // Deliberately keep the process alive with no windows so sync and
  // notifications continue running in the background on every platform.
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    actionExecutor?.stop()
    actionExecutor = null
    db?.close()
    db = null
  })
}
