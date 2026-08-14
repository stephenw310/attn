import { app, type IpcMainInvokeEvent, ipcMain, shell } from 'electron'
import type { AuthStatus } from '../shared/auth'
import { type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../shared/ipc'
import type {
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
  InlineImageRequest,
  InlineImageResult
} from '../shared/mail'
import { isTriageAction, pendingActionCount, performTriage, snoozeThreads, undoLast } from './actions'
import type { ActionExecutor } from './actions/executor'
import { writeAttachment } from './attachments'
import type { Db } from './db'
import {
  countInboxUnread,
  getConversation,
  getInlineAttachmentData,
  listInboxThreads,
  listSnoozedThreads,
  listUserLabels,
  searchContacts
} from './db/queries'
import type { GmailClient } from './gmail/client'
import type { PendingFocus } from './notify'
import { takePendingFocus } from './notify'
import type { SnoozeScheduler } from './scheduler'
import type { SyncController } from './syncController'

/**
 * Handler arguments stay `unknown`: the renderer is sandboxed but untrusted, so
 * the channel map's argument types describe what the preload promises to send,
 * never what main is allowed to assume. Results stay typed against the map, so
 * channel renames and result-shape changes are still compile-time failures.
 * Each handler narrows its own input with a guard below.
 */
type Handler<K extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => InvokeChannels[K]['result'] | Promise<InvokeChannels[K]['result']>

type SnoozeRequest = InvokeChannels[typeof IPC_CHANNELS.mailSnooze]['args'][0]

function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
}

export interface IpcContext {
  db: Db
  currentAccountId: () => string | null
  authStatus: () => AuthStatus
  signIn: () => Promise<AuthStatus>
  signOut: () => AuthStatus
  makeClient: () => GmailClient | null
  isSeeded: () => boolean
  executor: () => ActionExecutor | null
  scheduler: () => SnoozeScheduler | null
  syncController: () => SyncController | null
  broadcastMailChanged: () => void
  pendingFocus: () => PendingFocus | null
  clearPendingFocus: () => void
  waitForConversation: (threadId: string) => Promise<void>
  testUserData: boolean
}

type AttachmentDataRequest = Pick<DownloadAttachmentRequest, 'messageId' | 'attachmentId'>

function isAttachmentDataRequest(value: unknown): value is AttachmentDataRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AttachmentDataRequest>
  return (
    typeof candidate.messageId === 'string' &&
    candidate.messageId.length > 0 &&
    typeof candidate.attachmentId === 'string' &&
    candidate.attachmentId.length > 0
  )
}

function isDownloadAttachmentRequest(value: unknown): value is DownloadAttachmentRequest {
  return (
    isAttachmentDataRequest(value) &&
    typeof (value as Partial<DownloadAttachmentRequest>).filename === 'string' &&
    (value as DownloadAttachmentRequest).filename.length > 0
  )
}

function isInlineImageRequest(value: unknown): value is InlineImageRequest {
  return (
    isAttachmentDataRequest(value) &&
    typeof (value as Partial<InlineImageRequest>).mimeType === 'string' &&
    /^(?:image\/(?:png|jpeg|gif|webp))$/i.test((value as InlineImageRequest).mimeType)
  )
}

function isSnoozeRequest(value: unknown): value is SnoozeRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SnoozeRequest>
  return (
    Array.isArray(candidate.threadIds) &&
    candidate.threadIds.length > 0 &&
    candidate.threadIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof candidate.dueAt === 'number' &&
    Number.isFinite(candidate.dueAt)
  )
}

async function resolveAttachmentData(
  context: IpcContext,
  request: AttachmentDataRequest
): Promise<{ kind: 'available'; data: string } | { kind: 'signed-out' } | { kind: 'unavailable' }> {
  const account = context.currentAccountId()
  const inlineData = account
    ? getInlineAttachmentData(context.db, account, request.messageId, request.attachmentId)
    : null
  if (inlineData !== null) return { kind: 'available', data: inlineData }
  if (context.isSeeded()) return { kind: 'signed-out' }
  const client = context.makeClient()
  if (!client) return { kind: 'signed-out' }
  const data = (
    await client.get<{ data?: string }>(`/messages/${request.messageId}/attachments/${request.attachmentId}`)
  ).data
  return typeof data === 'string' ? { kind: 'available', data } : { kind: 'unavailable' }
}

export function registerIpc(context: IpcContext): void {
  handle(IPC_CHANNELS.authGetStatus, () => context.authStatus())
  handle(IPC_CHANNELS.authSignIn, () => context.signIn())
  handle(IPC_CHANNELS.authSignOut, () => context.signOut())
  handle(IPC_CHANNELS.contactsSearch, (_event, query) => {
    const account = context.currentAccountId()
    if (!account || typeof query !== 'string') return []
    return searchContacts(context.db, account, query.slice(0, 200))
  })
  handle(IPC_CHANNELS.syncGetState, () => context.syncController()?.getState() ?? { phase: 'idle' })
  handle(IPC_CHANNELS.syncRetry, () => {
    context.syncController()?.retry()
    return undefined
  })
  handle(IPC_CHANNELS.mailTakePendingFocus, () => {
    const threadId = takePendingFocus(context.pendingFocus())
    context.clearPendingFocus()
    return threadId
  })
  handle(IPC_CHANNELS.mailListThreads, () => {
    const account = context.currentAccountId()
    // Production deliberately keeps its M1 query cap. The perf-only seam lifts
    // it so the renderer benchmark actually mounts the generated 2,000 rows.
    const limit = context.testUserData && process.env.ATTN_E2E_PERF === '1' ? 2_000 : undefined
    return account ? listInboxThreads(context.db, account, limit) : []
  })
  handle(IPC_CHANNELS.mailListSnoozed, () => {
    const account = context.currentAccountId()
    return account ? listSnoozedThreads(context.db, account) : []
  })
  handle(IPC_CHANNELS.mailListLabels, () => {
    const account = context.currentAccountId()
    return account ? listUserLabels(context.db, account) : []
  })
  handle(IPC_CHANNELS.mailGetUnreadCount, () => {
    const account = context.currentAccountId()
    return account ? countInboxUnread(context.db, account) : 0
  })
  handle(IPC_CHANNELS.mailGetConversation, async (_event, threadId) => {
    if (typeof threadId !== 'string') return null
    await context.waitForConversation(threadId)
    const account = context.currentAccountId()
    return account ? getConversation(context.db, account, threadId) : null
  })
  handle(IPC_CHANNELS.mailDownloadAttachment, async (_event, request) => {
    if (!isDownloadAttachmentRequest(request)) return { error: 'Invalid attachment' }
    try {
      const resolved = await resolveAttachmentData(context, request)
      if (resolved.kind === 'signed-out') return { error: 'Attachments download when signed in' }
      if (resolved.kind === 'unavailable') return { error: 'Attachment data was unavailable' }
      const path = await writeAttachment(
        app.getPath('downloads'),
        request.filename,
        Buffer.from(resolved.data, 'base64url')
      )
      shell.showItemInFolder(path)
      return { path }
    } catch (error) {
      console.error(`[attachment] download failed: ${error instanceof Error ? error.message : String(error)}`)
      return { error: 'Could not download attachment' } satisfies DownloadAttachmentResult
    }
  })
  handle(IPC_CHANNELS.mailGetInlineImage, async (_event, request) => {
    if (!isInlineImageRequest(request)) return { error: 'Invalid inline image' }
    try {
      const resolved = await resolveAttachmentData(context, request)
      if (resolved.kind !== 'available') return { error: 'Inline image data was unavailable' }
      const bytes = Buffer.from(resolved.data, 'base64url')
      if (bytes.byteLength > 10 * 1024 * 1024) return { error: 'Inline image was too large' }
      return {
        dataUrl: `data:${request.mimeType.toLowerCase()};base64,${bytes.toString('base64')}`
      }
    } catch (error) {
      console.error(
        `[attachment] inline image failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return { error: 'Could not load inline image' } satisfies InlineImageResult
    }
  })
  handle(IPC_CHANNELS.mailTriage, (_event, action) => {
    if (!isTriageAction(action)) throw new Error('invalid triage action')
    const account = requireAccount(context)
    const result = performTriage(context.db, account, action)
    context.scheduler()?.refresh()
    context.broadcastMailChanged()
    void context.executor()?.trigger()
    return result
  })
  handle(IPC_CHANNELS.mailSnooze, (_event, input) => {
    if (!isSnoozeRequest(input)) throw new Error('invalid snooze request')
    const result = snoozeThreads(context.db, requireAccount(context), input.threadIds, input.dueAt)
    context.scheduler()?.refresh()
    context.broadcastMailChanged()
    void context.executor()?.trigger()
    return result
  })
  handle(IPC_CHANNELS.mailMarkReadOnOpen, (_event, threadId) => {
    if (typeof threadId !== 'string' || threadId.length === 0) throw new Error('invalid thread id')
    const account = requireAccount(context)
    const thread = context.db
      .prepare('SELECT is_unread FROM threads WHERE account_id = ? AND id = ?')
      .get(account, threadId) as { is_unread: number } | undefined
    const settled = context.db
      .prepare(
        `UPDATE reminders SET state = 'done'
         WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'returned'`
      )
      .run(account, threadId).changes
    const markedRead = thread?.is_unread === 1
    if (markedRead) {
      performTriage(context.db, account, { kind: 'markUnread', threadIds: [threadId], on: false }, false)
      void context.executor()?.trigger()
    }
    if (settled || markedRead) context.broadcastMailChanged()
    return undefined
  })
  handle(IPC_CHANNELS.mailUndo, () => {
    const account = context.currentAccountId()
    if (!account) return null
    const result = undoLast(context.db, account)
    if (result) {
      context.scheduler()?.refresh()
      context.broadcastMailChanged()
      void context.executor()?.trigger()
    }
    return result
  })
  handle(IPC_CHANNELS.mailGetPendingActionCount, () => {
    const account = context.currentAccountId()
    return account ? pendingActionCount(context.db, account) : 0
  })
}

function requireAccount(context: IpcContext): string {
  const account = context.currentAccountId()
  if (!account) throw new Error('not signed in')
  return account
}
