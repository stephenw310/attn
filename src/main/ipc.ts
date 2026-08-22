import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  shell
} from 'electron'
import type { ActionRevertNotice } from '../shared/actionRevert'
import { isValidEmail } from '../shared/address'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import {
  type DraftAttachment,
  type DraftInlineImageInput,
  type DraftSaveInput,
  emptyDraftInput
} from '../shared/drafts'
import { errorMessage } from '../shared/error'
import { nonEmptyString } from '../shared/guards'
import { type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../shared/ipc'
import type {
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
  InlineImageRepairRequest,
  InlineImageRequest,
  InlineImageResult
} from '../shared/mail'
import {
  actionQueueStatus,
  dropOutboxSendUndo,
  isTriageAction,
  pendingActionCount,
  performTriage,
  recordOutboxSendUndo,
  snoozeThreads,
  undoLast
} from './actions'
import type { ActionExecutor } from './actions/executor'
import { writeAttachment } from './attachments'
import type { Db } from './db'
import {
  countInboxUnread,
  getConversation,
  getConversationForDisplay,
  getInlineAttachmentData,
  listInboxThreads,
  listSnoozedThreads,
  listUserLabels,
  searchContacts
} from './db/queries'
import type { GmailClient } from './gmail/client'
import type { GmailMailProvider } from './gmail/provider'
import { inlineImageIsTooLarge } from './inlineImageLimit'
import type { PendingFocus } from './notify'
import { takePendingFocus } from './notify'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './outbox/draftAttachments'
import {
  canonicalizeRendererDraft,
  closeDraft,
  discardDraft,
  getDraft,
  listDrafts,
  reopenDraft,
  reopenThreadDraft,
  requestDraftMirror,
  saveDraft,
  takeRecoveredDraft,
  upgradeReplyToReplyAll
} from './outbox/drafts'
import { addInlineImage, isSupportedInlineImageMimeType } from './outbox/inlineImages'
import type { DraftMirrorExecutor } from './outbox/mirrorExecutor'
import { listPendingOutbox, queueSend, reopenPendingOutbox, undoQueuedSend } from './outbox/queue'
import { planReply } from './outbox/replyPlan'
import type { OutboxSender } from './outbox/sender'
import { cleanOutboxSpool, removeDraftAttachment, spoolDraftAttachments } from './outbox/spool'
import { isPathInside } from './pathSafety'
import type { SnoozeScheduler } from './scheduler'
import { hydrateMissingThreadBodies } from './sync/bodies'
import { idleMissingBodyState, relabelMissingBodyState } from './sync/bodyHydration'
import { OnDemandBodyHydrator } from './sync/onDemandBodies'
import { persistThread } from './sync/persist'
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
  signIn: () => Promise<AuthSignInResult>
  signOut: () => AuthStatus
  makeClient: () => GmailClient | null
  makeProvider: () => GmailMailProvider | null
  isSeeded: () => boolean
  executor: () => ActionExecutor | null
  draftMirrorExecutor: () => DraftMirrorExecutor | null
  outboxSender: () => OutboxSender | null
  scheduler: () => SnoozeScheduler | null
  syncController: () => SyncController | null
  broadcastMailChanged: () => void
  broadcastOutboxChanged: (change: import('../shared/outbox').OutboxChanged) => void
  broadcastBodyHydrationFailed: (accountId: string, threadId: string) => void
  trackForegroundProviderWork: <T>(accountId: string, work: () => Promise<T>) => Promise<T>
  pendingFocus: () => PendingFocus | null
  clearPendingFocus: () => void
  peekRevertedActions: (accountId: string) => ActionRevertNotice | null
  acknowledgeRevertedActions: (accountId: string, noticeId: number) => boolean
  waitForConversation: (threadId: string) => Promise<void>
  draftReopenDelay: () => number
  pickAttachmentPaths?: () => Promise<string[]>
  draftInlineImageDelay: () => number
  consumeTestDraftSaveFailure: () => boolean
  testUserData: boolean
}

type AttachmentDataRequest = Pick<DownloadAttachmentRequest, 'messageId' | 'attachmentId'>

function isAttachmentDataRequest(value: unknown): value is AttachmentDataRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AttachmentDataRequest>
  return nonEmptyString(candidate.messageId) && nonEmptyString(candidate.attachmentId)
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
    isSupportedInlineImageMimeType((value as InlineImageRequest).mimeType)
  )
}

function isInlineImageRepairRequest(value: unknown): value is InlineImageRepairRequest {
  if (!value || typeof value !== 'object') return false
  const threadId = (value as Partial<InlineImageRepairRequest>).threadId
  return nonEmptyString(threadId) && threadId.length <= 256
}

function isSnoozeRequest(value: unknown): value is SnoozeRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SnoozeRequest>
  return (
    Array.isArray(candidate.threadIds) &&
    candidate.threadIds.length > 0 &&
    candidate.threadIds.every((id) => nonEmptyString(id)) &&
    typeof candidate.dueAt === 'number' &&
    Number.isFinite(candidate.dueAt)
  )
}

function isDraftSaveInput(value: unknown): value is DraftSaveInput {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<DraftSaveInput>
  const recipientsValid = (recipients: unknown): boolean =>
    Array.isArray(recipients) &&
    recipients.every(
      (recipient) =>
        recipient !== null &&
        typeof recipient === 'object' &&
        typeof (recipient as { name?: unknown }).name === 'string' &&
        typeof (recipient as { email?: unknown }).email === 'string' &&
        isValidEmail((recipient as { email: string }).email)
    )
  const attachmentsValid = (attachments: unknown): boolean =>
    Array.isArray(attachments) &&
    attachments.every((attachment) => {
      if (!attachment || typeof attachment !== 'object') return false
      const candidate = attachment as Partial<DraftAttachment>
      return (
        nonEmptyString(candidate.id) &&
        candidate.id.length <= 200 &&
        typeof candidate.filename === 'string' &&
        candidate.filename.length <= 500 &&
        typeof candidate.mimeType === 'string' &&
        candidate.mimeType.length <= 100 &&
        typeof candidate.sizeBytes === 'number' &&
        Number.isSafeInteger(candidate.sizeBytes) &&
        candidate.sizeBytes >= 0 &&
        (candidate.contentId === undefined ||
          (typeof candidate.contentId === 'string' && candidate.contentId.length <= 500)) &&
        (candidate.inline === undefined || typeof candidate.inline === 'boolean')
      )
    })
  return (
    (draft.id === null || typeof draft.id === 'string') &&
    (draft.kind === 'new' ||
      draft.kind === 'reply' ||
      draft.kind === 'replyAll' ||
      draft.kind === 'forward') &&
    recipientsValid(draft.to) &&
    recipientsValid(draft.cc) &&
    recipientsValid(draft.bcc) &&
    typeof draft.subject === 'string' &&
    typeof draft.bodyHtml === 'string' &&
    typeof draft.bodyText === 'string' &&
    attachmentsValid(draft.attachments) &&
    (draft.threadId === null || typeof draft.threadId === 'string') &&
    (draft.sourceMessageId === null || typeof draft.sourceMessageId === 'string') &&
    (draft.inReplyTo === null || typeof draft.inReplyTo === 'string') &&
    Array.isArray(draft.references) &&
    draft.references.every((reference) => typeof reference === 'string') &&
    typeof draft.quoteHtml === 'string' &&
    typeof draft.quoteText === 'string'
  )
}

function isDraftInlineImageInput(value: unknown): value is DraftInlineImageInput {
  if (!value || typeof value !== 'object') return false
  const image = value as Partial<DraftInlineImageInput>
  return (
    typeof image.filename === 'string' &&
    image.filename.length <= 500 &&
    typeof image.mimeType === 'string' &&
    isSupportedInlineImageMimeType(image.mimeType) &&
    typeof image.dataBase64 === 'string' &&
    image.dataBase64.length <= 14 * 1024 * 1024
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
  if (!client || !account) return { kind: 'signed-out' }
  const data = await context.trackForegroundProviderWork(
    account,
    async () =>
      (
        await client.get<{ data?: string }>(
          `/messages/${request.messageId}/attachments/${request.attachmentId}`
        )
      ).data
  )
  return typeof data === 'string' ? { kind: 'available', data } : { kind: 'unavailable' }
}

export function registerIpc(context: IpcContext): () => void {
  const attemptedInlineImageRepairs = new Set<string>()
  const bodyHydrator = new OnDemandBodyHydrator(
    context.db,
    context.currentAccountId,
    context.broadcastMailChanged,
    (accountId, threadId, error) => {
      if (error !== undefined) {
        console.warn(`[mail] body hydration failed for ${threadId}: ${errorMessage(error)}`)
      }
      context.broadcastBodyHydrationFailed(accountId, threadId)
    },
    { trackProviderWork: context.trackForegroundProviderWork }
  )
  handle(IPC_CHANNELS.authGetStatus, () => context.authStatus())
  handle(IPC_CHANNELS.authSignIn, () => context.signIn())
  handle(IPC_CHANNELS.authSignOut, () => context.signOut())
  handle(IPC_CHANNELS.contactsSearch, (_event, query) => {
    const account = context.currentAccountId()
    if (!account || typeof query !== 'string') return []
    return searchContacts(context.db, account, query.slice(0, 200))
  })
  handle(IPC_CHANNELS.draftSave, (_event, draft) => {
    if (!isDraftSaveInput(draft)) throw new Error('invalid draft')
    if (context.consumeTestDraftSaveFailure()) throw new Error('injected draft save failure')
    const account = requireAccount(context)
    const canonical = canonicalizeRendererDraft(context.db, account, draft)
    const now = Date.now()
    const id = saveDraft(context.db, account, canonical, now)
    return {
      id,
      draft: canonical.id === null ? { ...canonical, id, createdAt: now, updatedAt: now } : null
    }
  })
  handle(IPC_CHANNELS.draftGet, (_event, id) => {
    if (typeof id !== 'string') return null
    return getDraft(context.db, requireAccount(context), id)
  })
  handle(IPC_CHANNELS.draftList, () => {
    const account = context.currentAccountId()
    return account ? listDrafts(context.db, account) : []
  })
  handle(IPC_CHANNELS.draftReopen, async (_event, id) => {
    if (!nonEmptyString(id)) return null
    const delay = context.testUserData ? context.draftReopenDelay() : 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return reopenDraft(context.db, requireAccount(context), id)
  })
  handle(IPC_CHANNELS.draftCreateReply, async (_event, threadId, kind) => {
    if (
      typeof threadId !== 'string' ||
      threadId.length === 0 ||
      (kind !== 'reply' && kind !== 'replyAll' && kind !== 'forward')
    ) {
      return null
    }
    const account = requireAccount(context)
    const existing = reopenThreadDraft(context.db, account, threadId, kind)
    const shouldUpgradeReplyAll = kind === 'replyAll' && existing?.kind === 'reply'
    if (existing && !shouldUpgradeReplyAll) return existing
    await context.waitForConversation(threadId)
    let conversation = getConversation(context.db, account, threadId, 'unavailable')
    if (!conversation || conversation.messages.length === 0) return existing
    if (existing) {
      // Recipient headers are available even when a message body is not. The
      // reused reply already owns its quote, so Reply-All stays local-first and
      // never waits on body hydration merely to add the planned To/Cc set.
      const plan = planReply('replyAll', conversation, account)
      const upgraded = upgradeReplyToReplyAll(context.db, account, existing.id, plan.to, plan.cc)
      context.broadcastMailChanged()
      return upgraded
    }
    if (conversation.messages.some((message) => message.bodyState !== 'complete')) {
      const provider = context.makeProvider()
      if (provider) {
        await bodyHydrator.request(account, threadId, provider)
        conversation = getConversation(context.db, account, threadId, 'unavailable')
      }
    }
    if (
      !conversation ||
      conversation.messages.length === 0 ||
      conversation.messages.some((message) => message.bodyState !== 'complete')
    ) {
      return null
    }
    const plan = planReply(kind, conversation, account)
    const source = conversation.messages.find((message) => message.id === plan.sourceMessageId)
    const quotedAttachments: StoredDraftAttachment[] = (source?.attachments ?? [])
      .filter(
        (attachment) =>
          (attachment.inline && Boolean(attachment.contentId)) || (kind === 'forward' && !attachment.inline)
      )
      .map((attachment) => {
        const inlineData = getInlineAttachmentData(
          context.db,
          account,
          plan.sourceMessageId,
          attachment.attachmentId
        )
        return {
          id: randomUUID(),
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          spoolPath: '',
          planned: true,
          remoteMessageId: plan.sourceMessageId,
          remoteAttachmentId: attachment.attachmentId,
          ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          ...(attachment.inline ? { inline: true } : {}),
          ...(inlineData ? { remoteInlineData: inlineData } : {})
        }
      })
    const input: DraftSaveInput = {
      ...emptyDraftInput(),
      kind,
      to: plan.to,
      cc: plan.cc,
      subject: plan.subject,
      threadId: plan.threadId,
      sourceMessageId: plan.sourceMessageId,
      inReplyTo: plan.inReplyTo,
      references: plan.references,
      attachments: quotedAttachments,
      quoteHtml: plan.quoteHtml,
      quoteText: plan.quoteText
    }
    const id = saveDraft(context.db, account, input)
    context.broadcastMailChanged()
    return getDraft(context.db, account, id)
  })
  handle(IPC_CHANNELS.draftPickAttachments, async (event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    let paths: string[]
    if (context.pickAttachmentPaths) paths = await context.pickAttachmentPaths()
    else {
      const options: OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        title: 'Attach files'
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      paths = (await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)))
        .filePaths
    }
    return spoolDraftAttachments(context.db, app.getPath('userData'), requireAccount(context), id, paths)
  })
  handle(IPC_CHANNELS.draftAddAttachments, async (_event, id, paths) => {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      !Array.isArray(paths) ||
      !paths.every((path) => nonEmptyString(path))
    ) {
      throw new Error('invalid attachments')
    }
    return spoolDraftAttachments(context.db, app.getPath('userData'), requireAccount(context), id, paths)
  })
  handle(IPC_CHANNELS.draftRemoveAttachment, async (_event, id, attachmentId) => {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof attachmentId !== 'string' ||
      attachmentId.length === 0
    ) {
      throw new Error('invalid attachment')
    }
    return removeDraftAttachment(
      context.db,
      app.getPath('userData'),
      requireAccount(context),
      id,
      attachmentId
    )
  })
  handle(IPC_CHANNELS.draftAddInlineImage, async (_event, id, image) => {
    if (!nonEmptyString(id) || !isDraftInlineImageInput(image)) {
      throw new Error('invalid inline image')
    }
    return addInlineImage(context.db, app.getPath('userData'), requireAccount(context), id, image)
  })
  handle(IPC_CHANNELS.draftGetInlineImage, async (_event, id, contentId) => {
    if (typeof id !== 'string' || typeof contentId !== 'string' || !contentId) {
      return { error: 'Invalid inline image' }
    }
    const account = requireAccount(context)
    const delay = context.testUserData ? context.draftInlineImageDelay() : 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const row = context.db
      .prepare(
        `SELECT attachments_json FROM outbox
         WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')`
      )
      .get(account, id) as { attachments_json: string } | undefined
    const attachment = row
      ? parseStoredDraftAttachments(row.attachments_json).find(
          (candidate) => candidate.contentId?.toLowerCase() === contentId.toLowerCase()
        )
      : undefined
    if (!attachment || !isSupportedInlineImageMimeType(attachment.mimeType)) {
      return { error: 'Inline image unavailable' }
    }
    try {
      let data: Buffer
      if (attachment.spoolPath) {
        const spoolRoot = resolve(app.getPath('userData'), 'outbox', id)
        const candidate = resolve(attachment.spoolPath)
        if (!isPathInside(spoolRoot, candidate)) {
          return { error: 'Inline image unavailable' }
        }
        data = await readFile(candidate)
      } else if (attachment.remoteInlineData) {
        data = Buffer.from(attachment.remoteInlineData, 'base64url')
      } else if (attachment.remoteMessageId && attachment.remoteAttachmentId) {
        const client = context.makeClient()
        if (!client) return { error: 'Inline image requires sign in' }
        const remoteMessageId = attachment.remoteMessageId
        const remoteAttachmentId = attachment.remoteAttachmentId
        const result = await context.trackForegroundProviderWork(account, () =>
          client.get<{ data?: string }>(
            `/messages/${encodeURIComponent(remoteMessageId)}/attachments/${encodeURIComponent(remoteAttachmentId)}`
          )
        )
        if (!result.data) return { error: 'Inline image unavailable' }
        data = Buffer.from(result.data, 'base64url')
      } else return { error: 'Inline image unavailable' }
      if (inlineImageIsTooLarge(data.byteLength)) return { error: 'Inline image was too large' }
      return { dataUrl: `data:${attachment.mimeType};base64,${data.toString('base64')}` }
    } catch {
      return { error: 'Inline image unavailable' }
    }
  })
  handle(IPC_CHANNELS.draftClose, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    const result = closeDraft(context.db, requireAccount(context), id)
    context.broadcastMailChanged()
    if (result === 'discarded') {
      cleanOutboxSpool(app.getPath('userData'), id)
      void context.draftMirrorExecutor()?.trigger()
    }
    return result
  })
  handle(IPC_CHANNELS.draftDiscard, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    if (!discardDraft(context.db, requireAccount(context), id)) throw new Error('draft is unavailable')
    cleanOutboxSpool(app.getPath('userData'), id)
    context.broadcastMailChanged()
    void context.draftMirrorExecutor()?.trigger()
    return undefined
  })
  handle(IPC_CHANNELS.draftMirror, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    if (requestDraftMirror(context.db, requireAccount(context), id)) {
      void context.draftMirrorExecutor()?.trigger()
    }
    return undefined
  })
  handle(IPC_CHANNELS.draftTakeRecovered, () => takeRecoveredDraft(context.db, requireAccount(context)))
  handle(IPC_CHANNELS.outboxSend, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    const account = requireAccount(context)
    const result = queueSend(context.db, account, id)
    recordOutboxSendUndo(account, id)
    context.broadcastOutboxChanged({ kind: 'changed' })
    context.outboxSender()?.refresh()
    return result
  })
  handle(IPC_CHANNELS.outboxUndoSend, (_event, id) => {
    if (!nonEmptyString(id)) return { draft: null, error: 'Invalid message' }
    const account = requireAccount(context)
    const result = undoQueuedSend(context.db, account, id)
    if (result.draft) dropOutboxSendUndo(account, id)
    context.broadcastOutboxChanged({ kind: 'changed' })
    context.outboxSender()?.refresh()
    return result
  })
  handle(IPC_CHANNELS.outboxReopen, (_event, id) => {
    if (!nonEmptyString(id)) return { draft: null, error: 'Invalid message' }
    const account = requireAccount(context)
    const result = reopenPendingOutbox(context.db, account, id)
    if (result.draft) {
      dropOutboxSendUndo(account, id)
      context.broadcastOutboxChanged({ kind: 'changed' })
    }
    return result
  })
  handle(IPC_CHANNELS.outboxListPending, () => {
    const account = context.currentAccountId()
    return account ? listPendingOutbox(context.db, account) : []
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
  handle(IPC_CHANNELS.mailPeekActionsReverted, (_event, accountId) => {
    const account = context.currentAccountId()
    return typeof accountId === 'string' && accountId === account
      ? context.peekRevertedActions(accountId)
      : null
  })
  handle(IPC_CHANNELS.mailAcknowledgeActionsReverted, (_event, accountId, noticeId) => {
    if (typeof accountId !== 'string' || typeof noticeId !== 'number') return false
    if (context.currentAccountId() !== accountId) return false
    return context.acknowledgeRevertedActions(accountId, noticeId)
  })
  handle(IPC_CHANNELS.mailListThreads, () => {
    const account = context.currentAccountId()
    return account ? listInboxThreads(context.db, account) : []
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
  handle(IPC_CHANNELS.mailGetConversation, async (_event, threadId, allowHydration) => {
    if (typeof threadId !== 'string') return null
    await context.waitForConversation(threadId)
    const account = context.currentAccountId()
    if (!account) return null
    const attemptState = bodyHydrator.state(account, threadId)
    const conversation = getConversationForDisplay(
      context.db,
      account,
      threadId,
      attemptState === 'idle' ? idleMissingBodyState(context.isSeeded()) : attemptState
    )
    if (
      !conversation?.messages.some((message) => message.bodyState !== 'complete') ||
      allowHydration !== true
    ) {
      return conversation
    }
    if (context.isSeeded()) return conversation
    const provider = context.makeProvider()
    if (!provider) return relabelMissingBodyState(conversation, 'signed-out')
    setImmediate(() => void bodyHydrator.request(account, threadId, provider))
    return relabelMissingBodyState(conversation, 'loading')
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
      console.error(`[attachment] download failed: ${errorMessage(error)}`)
      return { error: 'Could not download attachment' } satisfies DownloadAttachmentResult
    }
  })
  handle(IPC_CHANNELS.mailGetInlineImage, async (_event, request) => {
    if (!isInlineImageRequest(request)) return { error: 'Invalid inline image' }
    try {
      const resolved = await resolveAttachmentData(context, request)
      if (resolved.kind !== 'available') return { error: 'Inline image data was unavailable' }
      const bytes = Buffer.from(resolved.data, 'base64url')
      if (inlineImageIsTooLarge(bytes.byteLength)) return { error: 'Inline image was too large' }
      return {
        dataUrl: `data:${request.mimeType.toLowerCase()};base64,${bytes.toString('base64')}`
      }
    } catch (error) {
      console.error(`[attachment] inline image failed: ${errorMessage(error)}`)
      return { error: 'Could not load inline image' } satisfies InlineImageResult
    }
  })
  handle(IPC_CHANNELS.mailRepairInlineImages, async (_event, request) => {
    if (!isInlineImageRepairRequest(request)) return false
    const accountId = context.currentAccountId()
    const provider = context.makeProvider()
    if (!accountId || !provider) return false
    const repairKey = `${accountId}\0${request.threadId}`
    if (attemptedInlineImageRepairs.has(repairKey)) return false
    attemptedInlineImageRepairs.add(repairKey)
    try {
      return await context.trackForegroundProviderWork(accountId, async () => {
        const thread = await provider.getThread(request.threadId, { format: 'full' })
        if (context.currentAccountId() !== accountId) return false
        persistThread(context.db, accountId, thread)
        await hydrateMissingThreadBodies(context.db, provider, accountId, thread)
        if (context.currentAccountId() === accountId) context.broadcastMailChanged()
        return true
      })
    } catch (error) {
      attemptedInlineImageRepairs.delete(repairKey)
      console.error(`[attachment] inline image repair failed: ${errorMessage(error)}`)
      return false
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
    if (!nonEmptyString(threadId)) throw new Error('invalid thread id')
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
      if (result.reopenDraftId) {
        context.outboxSender()?.refresh()
        context.broadcastOutboxChanged({ kind: 'changed' })
      }
    }
    return result
  })
  handle(IPC_CHANNELS.mailGetPendingActionCount, () => {
    const account = context.currentAccountId()
    return account ? pendingActionCount(context.db, account) : 0
  })
  handle(IPC_CHANNELS.mailGetActionQueueStatus, () => {
    const account = context.currentAccountId()
    return account ? actionQueueStatus(context.db, account) : { pending: 0, paused: 0, authPaused: false }
  })
  return () => bodyHydrator.stop()
}

function requireAccount(context: IpcContext): string {
  const account = context.currentAccountId()
  if (!account) throw new Error('not signed in')
  return account
}
