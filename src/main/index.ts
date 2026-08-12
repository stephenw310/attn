import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import type { AuthStatus } from '../shared/auth'
import type { DownloadAttachmentRequest, DownloadAttachmentResult, SyncState } from '../shared/mail'
import {
  clearUndo,
  isTriageAction,
  pendingActionCount,
  performTriage,
  snoozeThreads,
  undoLast
} from './actions'
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
  listSnoozedThreads,
  listUserLabels
} from './db/queries'
import { loadSeed } from './dev/seed'
import { GmailClient } from './gmail/client'
import { GmailMailProvider } from './gmail/provider'
import { MailNotifier } from './notify'
import { SnoozeScheduler } from './scheduler'
import { runInboxBackfill } from './sync/backfill'
import { HistoryPoller, reconcileInboxMembership } from './sync/poller'
import { sameSyncState } from './sync/state'

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
let historyPoller: HistoryPoller | null = null
let snoozeScheduler: SnoozeScheduler | null = null
let mailNotifier: MailNotifier | null = null
let pendingFocusThreadId: string | null = null

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function broadcastMailChanged(): void {
  broadcast('mail:changed')
  mailNotifier?.updateBadge()
}

function focusInboxThread(threadId: string): void {
  pendingFocusThreadId = threadId
  const win = showMainWindow()
  win?.webContents.send('mail:focusThreadAvailable')
}

function setSyncState(s: SyncState): void {
  if (sameSyncState(syncState, s)) return
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
  if (!db || syncRunning || seedAccountId || historyPoller) return
  const generation = authSessionGeneration
  const accountId = currentAccountId()
  const provider = makeProvider()
  if (!accountId) return
  if (!provider) {
    const message = 'OAuth configuration unavailable — add oauth.config.json'
    setSyncState({ phase: 'error', message })
    console.error(`[sync] failed: ${message}`)
    return
  }
  const state = db.prepare('SELECT backfill_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
    | { backfill_cursor: string | null }
    | undefined
  if (state?.backfill_cursor === 'done') {
    startHistoryPoller(accountId, provider, generation)
    return
  }
  syncRunning = true
  setSyncState({ phase: 'syncing', threadsDone: 0 })
  console.log('[sync] inbox backfill started')
  const activeDb = db
  void runInboxBackfill(activeDb, provider, {
    onProgress: (threadsDone) => {
      if (generation !== authSessionGeneration) return
      setSyncState({ phase: 'syncing', threadsDone })
      broadcastMailChanged()
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
    .then((result) => {
      syncRunning = false
      if (!result) return
      if (generation !== authSessionGeneration) {
        if (authStatus().signedIn) void resumeOnlineWork()
        return
      }
      reconcileInboxMembership(activeDb, accountId, result.inboxThreadIds)
      setSyncState({ phase: 'idle' })
      broadcastMailChanged()
      console.log(`[sync] backfill done: ${result.threadCount} inbox threads for ${accountId}`)
      startHistoryPoller(accountId, provider, generation)
    })
    .catch((error) => {
      syncRunning = false
      if (generation !== authSessionGeneration) {
        if (authStatus().signedIn) void resumeOnlineWork()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      setSyncState({ phase: 'error', message })
      console.error(`[sync] failed after backfill: ${message}`)
    })
}

function startHistoryPoller(accountId: string, provider: GmailMailProvider, generation: number): void {
  if (!db || generation !== authSessionGeneration || historyPoller) return
  const activeDb = db
  historyPoller = new HistoryPoller({
    db: activeDb,
    accountId,
    provider,
    isForeground: () => BrowserWindow.getAllWindows().some((win) => win.isFocused()),
    recoverExpiredHistory: async () => {
      if (generation !== authSessionGeneration) throw new Error('authentication session changed')
      syncRunning = true
      setSyncState({ phase: 'syncing', threadsDone: 0 })
      let failureMessage = 'history recovery backfill failed'
      try {
        const result = await runInboxBackfill(
          activeDb,
          provider,
          {
            onProgress: (threadsDone) => {
              if (generation === authSessionGeneration) {
                setSyncState({ phase: 'syncing', threadsDone })
              }
            },
            onError: (message) => {
              failureMessage = message
            }
          },
          { recovery: true }
        )
        if (!result) throw new Error(failureMessage)
        if (generation !== authSessionGeneration) throw new Error('authentication session changed')
        reconcileInboxMembership(activeDb, accountId, result.inboxThreadIds)
      } finally {
        syncRunning = false
        if (generation !== authSessionGeneration && authStatus().signedIn) {
          void resumeOnlineWork()
        }
      }
    },
    onCycleComplete: (changed) => {
      if (generation !== authSessionGeneration) return
      setSyncState({ phase: 'idle' })
      if (changed) broadcastMailChanged()
    },
    onError: (message) => {
      if (generation !== authSessionGeneration) return
      syncRunning = false
      setSyncState({ phase: 'error', message })
      console.error(`[sync] history poll failed: ${message}`)
    },
    wakeThread: (threadId) => {
      snoozeScheduler?.wakeThread(threadId)
    },
    kickExecutor: () => {
      if (pendingActionCount(activeDb, accountId) > 0) void actionExecutor?.trigger()
    }
  })
  historyPoller.start()
}

function stopHistoryPoller(): void {
  historyPoller?.stop()
  historyPoller = null
}

async function resumeOnlineWork(): Promise<void> {
  // Remote changes must keep flowing even when a queued local action is in
  // Gmail's retry/backoff loop. The executor and history poller are independent.
  if (authStatus().signedIn) startSync()
  await actionExecutor?.trigger()
  // A sign-out/account switch can make an active drain finish early. A second
  // pass picks up the newly active account.
  await actionExecutor?.trigger()
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
      stopHistoryPoller()
      authSessionGeneration++
      saveTokens(app.getPath('userData'), tokens)
      mailNotifier?.setAccountId(tokens.email ?? null)
      console.log(`[auth] signed in as ${tokens.email ?? 'unknown'}`)
      snoozeScheduler?.refresh()
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
    stopHistoryPoller()
    authSessionGeneration++
    seedAccountId = null
    clearTokens(app.getPath('userData'))
    mailNotifier?.setAccountId(null)
    clearUndo(account ?? undefined)
    snoozeScheduler?.refresh()
    // A stale backfill may finish caching locally, but its generation can no
    // longer persist refreshed tokens or publish state for the signed-out user.
    setSyncState({ phase: 'idle' })
    console.log('[auth] signed out')
    return authStatus()
  })

  ipcMain.handle('sync:getState', () => syncState)
  ipcMain.handle('mail:takePendingFocus', () => {
    const threadId = pendingFocusThreadId
    pendingFocusThreadId = null
    return threadId
  })
  ipcMain.handle('mail:listThreads', () => {
    if (!db) return []
    const account = currentAccountId()
    // Production deliberately keeps its M1 query cap. The perf-only seam lifts
    // it so the renderer benchmark actually mounts the generated 2,000 rows.
    const limit = testUserData && process.env.ATTN_E2E_PERF === '1' ? 2_000 : undefined
    return account ? listInboxThreads(db, account, limit) : []
  })
  ipcMain.handle('mail:listSnoozed', () => {
    if (!db) return []
    const account = currentAccountId()
    return account ? listSnoozedThreads(db, account) : []
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
    snoozeScheduler?.refresh()
    broadcastMailChanged()
    void actionExecutor?.trigger()
    return result
  })
  ipcMain.handle('mail:snooze', (_e, input: unknown) => {
    if (!db) throw new Error('database unavailable')
    if (!input || typeof input !== 'object') throw new Error('invalid snooze request')
    const { threadIds, dueAt } = input as Record<string, unknown>
    if (
      !Array.isArray(threadIds) ||
      threadIds.length === 0 ||
      !threadIds.every((id) => typeof id === 'string' && id.length > 0) ||
      typeof dueAt !== 'number' ||
      !Number.isFinite(dueAt)
    ) {
      throw new Error('invalid snooze request')
    }
    const account = currentAccountId()
    if (!account) throw new Error('not signed in')
    const result = snoozeThreads(db, account, threadIds, dueAt)
    snoozeScheduler?.refresh()
    broadcastMailChanged()
    void actionExecutor?.trigger()
    return result
  })
  ipcMain.handle('mail:markReadOnOpen', (_e, threadId: unknown) => {
    if (!db || typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('invalid thread id')
    }
    const account = currentAccountId()
    if (!account) throw new Error('not signed in')
    const thread = db
      .prepare('SELECT is_unread FROM threads WHERE account_id = ? AND id = ?')
      .get(account, threadId) as { is_unread: number } | undefined
    const settled = db
      .prepare(
        `UPDATE reminders SET state = 'done'
       WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'returned'`
      )
      .run(account, threadId).changes
    const markedRead = thread?.is_unread === 1
    if (markedRead) {
      performTriage(db, account, { kind: 'markUnread', threadIds: [threadId], on: false }, false)
      void actionExecutor?.trigger()
    }
    if (settled || markedRead) broadcastMailChanged()
  })
  ipcMain.handle('mail:undo', () => {
    if (!db) return null
    const account = currentAccountId()
    if (!account) return null
    const result = undoLast(db, account)
    if (result) {
      snoozeScheduler?.refresh()
      broadcastMailChanged()
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
    actionExecutor = new ActionExecutor(db, currentAccountId, makeProvider, broadcastMailChanged)
    snoozeScheduler = new SnoozeScheduler(
      db,
      currentAccountId,
      broadcastMailChanged,
      () => void actionExecutor?.trigger()
    )
    snoozeScheduler.start()
    powerMonitor.on('resume', refreshSnoozesAfterResume)
    const { startHidden } = initializeBackground(db, createWindow)
    createWindow({ show: !startHidden })
    mailNotifier = new MailNotifier(db, currentAccountId(), showMainWindow, focusInboxThread)
    mailNotifier.start()
    if (testUserData) {
      ipcMain.on('attn:test:focusThread', (_event, threadId: unknown) => {
        if (typeof threadId === 'string' && threadId.length > 0) focusInboxThread(threadId)
      })
    }
    if (authStatus().signedIn) void resumeOnlineWork()
    app.on('activate', () => showMainWindow())
  })

  // Deliberately keep the process alive with no windows so sync and
  // notifications continue running in the background on every platform.
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    stopHistoryPoller()
    powerMonitor.removeListener('resume', refreshSnoozesAfterResume)
    actionExecutor?.stop()
    actionExecutor = null
    snoozeScheduler?.stop()
    snoozeScheduler = null
    mailNotifier?.stop()
    mailNotifier = null
    ipcMain.removeAllListeners('attn:test:focusThread')
    db?.close()
    db = null
  })
}

function refreshSnoozesAfterResume(): void {
  snoozeScheduler?.refresh()
}
