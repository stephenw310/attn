import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ActionRevertNotice } from '../../shared/actionRevert'
import { isValidEmail } from '../../shared/address'
import { validateAiSettingUpdate } from '../../shared/ai'
import { parseStoredCommandUsage, sanitizeCommandUsage } from '../../shared/commandUsage'
import {
  type DraftAttachment,
  type DraftInlineImageInput,
  type DraftSaveInput,
  emptyDraftInput
} from '../../shared/drafts'
import { errorMessage } from '../../shared/error'
import { nonEmptyString } from '../../shared/guards'
import { type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../../shared/ipc'
import {
  type ConversationMailbox,
  type DownloadAttachmentRequest,
  type DownloadAttachmentResult,
  type InlineImageRepairRequest,
  type InlineImageRequest,
  type InlineImageResult,
  type SystemMailboxCounts,
  THREAD_PAGE_SIZE,
  type ThreadListRequest,
  type ThreadListView,
  type ThreadPage,
  type ThreadPageCursor,
  type ThreadRow
} from '../../shared/mail'
import { validateAccountSettingUpdate } from '../../shared/settings'
import type { ReorderSplitsInput, SaveSplitInput, SplitCondition, SplitPresetId } from '../../shared/splits'
import { SPLIT_PRESET_IDS } from '../../shared/splits'
import { isThemePreference } from '../../shared/theme'
import {
  actionQueueStatus,
  dropOutboxSendUndo,
  isTriageAction,
  pendingActionCount,
  performTriage,
  recordOutboxSendUndo,
  snoozeThreads,
  undoLast
} from '../actions'
import type { ActionExecutor } from '../actions/executor'
import { listStyleExamples } from '../ai/styleExamples'
import { readAiStoredSettings, writeAiStoredSetting } from '../aiSettings'
import { readAccountSettings, readAppSettings, writeAppSetting } from '../appSettings'
import { writeAttachment } from '../attachments'
import type { Db } from '../db'
import {
  countInboxUnread,
  getConversation,
  getConversationForDisplay,
  getInlineAttachmentData,
  listInboxThreads,
  listLabelThreads,
  listMailboxThreads,
  listSnoozedThreads,
  listUserLabels,
  searchContacts
} from '../db/queries'
import { searchThreads } from '../db/search'
import type { GmailClient } from '../gmail/client'
import type { GmailMailProvider } from '../gmail/provider'
import { inlineImageIsTooLarge } from '../inlineImageLimit'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from '../outbox/draftAttachments'
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
} from '../outbox/drafts'
import { addInlineImage, isSupportedInlineImageMimeType } from '../outbox/inlineImages'
import type { DraftMirrorExecutor } from '../outbox/mirrorExecutor'
import { listPendingOutbox, queueSend, reopenPendingOutbox, undoQueuedSend } from '../outbox/queue'
import { planReply, replySourceMessage } from '../outbox/replyPlan'
import { ATTN_SIGNATURE_SETTING, prepareDraftWithCachedPrimarySignature } from '../outbox/sendAs'
import type { OutboxSender } from '../outbox/sender'
import { cleanOutboxSpool, removeDraftAttachment, spoolDraftAttachments } from '../outbox/spool'
import { isPathInside } from '../pathSafety'
import {
  addRemoteImageOverride,
  listRemoteImageOverrides,
  removeRemoteImageOverride,
  resolveMessageSender
} from '../remoteImageStore'
import type { SnoozeScheduler } from '../scheduler'
import {
  deleteAccountSetting,
  readAccountSetting,
  readSetting,
  writeAccountSetting,
  writeSetting
} from '../settings'
import { deleteSnippet, isSnippetSaveInput, listSnippets, saveSnippet } from '../snippets'
import {
  deleteSplit,
  hasSplitSetup,
  reorderSplits,
  restoreSplitPreset,
  saveSplit,
  setSplitNotify,
  splitLocationForThread,
  splitRevision
} from '../splits'
import { hydrateMissingThreadBodies } from '../sync/bodies'
import { idleMissingBodyState, relabelMissingBodyState } from '../sync/bodyHydration'
import { fetchAndCacheThread } from '../sync/fetchThread'
import { inboxBackfillReady } from '../sync/inboxReady'
import { applyLifetimeCapChange } from '../sync/lifetimeCap'
import { OnDemandBodyHydrator } from '../sync/onDemandBodies'
import { type ServerSearchProvider, searchAllGmail, serverSearchFailure } from '../sync/serverSearch'
import type { SyncController } from '../syncController'

/**
 * Handler arguments stay `unknown`: the renderer is sandboxed but untrusted, so
 * the channel map's argument types describe what the preload promises to send,
 * never what main is allowed to assume. Results stay typed against the map, so
 * channel renames and result-shape changes are still compile-time failures.
 * Each handler narrows its own input with a guard below.
 */
type Handler<K extends InvokeChannel> = (
  event: undefined,
  ...args: unknown[]
) => InvokeChannels[K]['result'] | Promise<InvokeChannels[K]['result']>

type SnoozeRequest = InvokeChannels[typeof IPC_CHANNELS.mailSnooze]['args'][0]

export interface ServiceHandlerContext {
  db: Db
  currentAccountId: () => string | null
  /** Per-account one-line health readouts for the account menu (F18). */
  accountStatuses: () => import('../../shared/auth').AccountSyncStatus[]
  makeClient: () => GmailClient | null
  makeProvider: () => GmailMailProvider | null
  makeServerSearchProvider: () => ServerSearchProvider | null
  isSeeded: () => boolean
  executor: () => ActionExecutor | null
  draftMirrorExecutor: () => DraftMirrorExecutor | null
  outboxSender: () => OutboxSender | null
  scheduler: () => SnoozeScheduler | null
  syncController: () => SyncController | null
  broadcastMailChanged: (serverSearchRequestId?: string) => void
  /** Push the stored remote-image policy to main's request filter (T33). */
  publishRemoteImagePolicy: () => void
  mailboxCounts: (accountId: string) => SystemMailboxCounts
  splitState: (accountId: string) => import('../../shared/splits').SplitState
  broadcastOutboxChanged: (change: import('../../shared/outbox').OutboxChanged) => void
  broadcastBodyHydrationFailed: (accountId: string, threadId: string) => void
  trackForegroundProviderWork: <T>(accountId: string, work: () => Promise<T>) => Promise<T>
  peekRevertedActions: (accountId: string) => ActionRevertNotice | null
  acknowledgeRevertedActions: (accountId: string, noticeId: number) => boolean
  waitForConversation: (threadId: string) => Promise<void>
  draftReopenDelay: () => number
  draftInlineImageDelay: () => number
  consumeTestDraftSaveFailure: () => boolean
  /** Test-only override of the search recency window; null in production. */
  searchWindowOverride: () => number | null
  testUserData: boolean
  userDataPath: string
  downloadsPath: string
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

const THREAD_LIST_VIEWS: readonly ThreadListView[] = [
  'inbox',
  'allMail',
  'sent',
  'starred',
  'snoozed',
  'spam',
  'trash'
]

function isThreadListRequest(value: unknown): value is ThreadListRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as {
    view?: unknown
    labelId?: unknown
    splitId?: unknown
    cursor?: unknown
    threadId?: unknown
  }
  if (request.cursor !== undefined && !isThreadPageCursor(request.cursor)) return false
  if (request.threadId !== undefined && !nonEmptyString(request.threadId)) return false
  if (request.view === 'label') return nonEmptyString(request.labelId)
  if (request.splitId !== undefined && (request.view !== 'inbox' || !nonEmptyString(request.splitId))) {
    return false
  }
  return typeof request.view === 'string' && (THREAD_LIST_VIEWS as readonly string[]).includes(request.view)
}

function isThreadPageCursor(value: unknown): value is ThreadPageCursor {
  if (!value || typeof value !== 'object') return false
  const cursor = value as { at?: unknown; id?: unknown; tier?: unknown }
  if (cursor.tier !== undefined && cursor.tier !== 'followUp') return false
  return typeof cursor.at === 'number' && Number.isFinite(cursor.at) && nonEmptyString(cursor.id)
}

function threadPage<Row extends ThreadRow>(
  rows: Row[],
  snoozed = false,
  splitRevisionValue?: number
): ThreadPage<Row> {
  const hasMore = rows.length > THREAD_PAGE_SIZE
  const pageRows = hasMore ? rows.slice(0, THREAD_PAGE_SIZE) : rows
  const last = pageRows.at(-1)
  // A page ending inside the inbox's returned-follow-up tier continues by the
  // tier's own due_at keyset; every other view pages by its date sort key.
  const tierAt = last && typeof last.followUpTierAt === 'number' ? last.followUpTierAt : undefined
  const cursorAt =
    snoozed && last && 'dueAt' in last && typeof last.dueAt === 'number' ? last.dueAt : last?.lastMsgAt
  const nextCursor: ThreadPageCursor | null =
    hasMore && last
      ? tierAt !== undefined
        ? { at: tierAt, id: last.id, tier: 'followUp' }
        : cursorAt !== undefined
          ? { at: cursorAt, id: last.id }
          : null
      : null
  return {
    rows: pageRows,
    nextCursor,
    ...(splitRevisionValue === undefined ? {} : { splitRevision: splitRevisionValue })
  }
}

function isSplitCondition(value: unknown): value is SplitCondition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; value?: unknown }
  if (candidate.type === 'listIdPresent') return candidate.value === undefined
  return (
    (candidate.type === 'senderAddress' ||
      candidate.type === 'senderDomain' ||
      candidate.type === 'listId' ||
      candidate.type === 'label' ||
      candidate.type === 'attachmentMimeType' ||
      candidate.type === 'attachmentFilenameSuffix') &&
    typeof candidate.value === 'string'
  )
}

function isSaveSplitInput(value: unknown): value is SaveSplitInput {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SaveSplitInput>
  return (
    (candidate.id === undefined || nonEmptyString(candidate.id)) &&
    typeof candidate.name === 'string' &&
    (candidate.operator === 'any' || candidate.operator === 'all') &&
    Array.isArray(candidate.conditions) &&
    candidate.conditions.every(isSplitCondition) &&
    typeof candidate.notify === 'boolean'
  )
}

function isReorderSplitsInput(value: unknown): value is ReorderSplitsInput {
  if (!value || typeof value !== 'object') return false
  const ids = (value as Partial<ReorderSplitsInput>).ids
  return Array.isArray(ids) && ids.every((id) => nonEmptyString(id))
}

const CONVERSATION_MAILBOXES: readonly ConversationMailbox[] = ['normal', 'all-mail', 'spam', 'trash']

function isConversationMailbox(value: unknown): value is ConversationMailbox {
  return typeof value === 'string' && (CONVERSATION_MAILBOXES as readonly string[]).includes(value)
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
  context: ServiceHandlerContext,
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

export interface ServiceHandlers {
  invoke<K extends InvokeChannel>(channel: K, args: unknown[]): Promise<InvokeChannels[K]['result']>
  stop(): void
}

export function createServiceHandlers(context: ServiceHandlerContext): ServiceHandlers {
  const registered = new Map<InvokeChannel, Handler<InvokeChannel>>()
  const handle = <K extends InvokeChannel>(channel: K, handler: Handler<K>): void => {
    registered.set(channel, handler as Handler<InvokeChannel>)
  }
  const attemptedInlineImageRepairs = new Set<string>()
  const activeServerSearches = new Map<string, AbortController>()
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
  handle(IPC_CHANNELS.contactsSearch, (_event, query) => {
    const account = context.currentAccountId()
    if (!account || typeof query !== 'string') return []
    return searchContacts(context.db, account, query.slice(0, 200))
  })
  handle(IPC_CHANNELS.settingsGetTheme, () => {
    const stored = readSetting(context.db, 'theme')
    return isThemePreference(stored) ? stored : 'system'
  })
  handle(IPC_CHANNELS.settingsSetTheme, (_event, preference) => {
    if (!isThemePreference(preference)) throw new Error('invalid theme preference')
    writeSetting(context.db, 'theme', preference)
    return preference
  })
  handle(IPC_CHANNELS.settingsGetAll, () => readAppSettings(context.db))
  handle(IPC_CHANNELS.settingsSet, (_event, key, value) => {
    const settings = writeAppSetting(context.db, key, value)
    if (key === 'remoteImagesBlocked') context.publishRemoteImagePolicy()
    return settings
  })
  handle(IPC_CHANNELS.settingsGetAccount, (_event, accountId) => {
    const account = requireAccount(context)
    if (typeof accountId !== 'string' || accountId !== account) throw new Error('account changed')
    return readAccountSettings(context.db, account)
  })
  handle(IPC_CHANNELS.settingsSetAccount, (_event, accountId, key, value) => {
    // Bind the write to the account named at dispatch: a completion that
    // lands after a switch must not touch the newly selected account (F18).
    const account = requireAccount(context)
    if (typeof accountId !== 'string' || accountId !== account) throw new Error('account changed')
    const update = validateAccountSettingUpdate(key, value)
    if (update.key === 'lifetimeThreadCap') {
      applyLifetimeCapChange(context.db, context.syncController(), account, update.value)
    } else if (update.key === 'attnSignatureEnabled') {
      // Absent means off (F6): disabling removes the row so a re-added
      // account starts from the documented default.
      if (update.value) writeAccountSetting(context.db, account, ATTN_SIGNATURE_SETTING, 'true')
      else deleteAccountSetting(context.db, account, ATTN_SIGNATURE_SETTING)
    }
    return readAccountSettings(context.db, account)
  })
  handle(IPC_CHANNELS.settingsGetCommandUsage, (_event, accountId) => {
    const account = requireAccount(context)
    if (typeof accountId !== 'string' || accountId !== account) throw new Error('account changed')
    return parseStoredCommandUsage(readAccountSetting(context.db, account, 'commandPaletteUsage'))
  })
  handle(IPC_CHANNELS.settingsSetCommandUsage, (_event, accountId, usage) => {
    const account = requireAccount(context)
    if (typeof accountId !== 'string' || accountId !== account) throw new Error('account changed')
    const sanitized = sanitizeCommandUsage(usage)
    writeAccountSetting(context.db, account, 'commandPaletteUsage', JSON.stringify(sanitized))
    return sanitized
  })
  // T36 AI settings storage. keyPresent is main-only custody: the utility
  // reports false and main overwrites it from the encrypted key file.
  handle(IPC_CHANNELS.aiGetSettings, () => ({ ...readAiStoredSettings(context.db), keyPresent: false }))
  handle(IPC_CHANNELS.aiSetSetting, (_event, key, value) => {
    const update = validateAiSettingUpdate(key, value)
    return { ...writeAiStoredSetting(context.db, update), keyPresent: false }
  })
  handle(IPC_CHANNELS.aiStyleExamples, () => {
    const account = context.currentAccountId()
    return account ? listStyleExamples(context.db, account) : []
  })
  handle(IPC_CHANNELS.snippetsList, () => listSnippets(context.db))
  handle(IPC_CHANNELS.snippetsSave, (_event, input) => {
    if (!isSnippetSaveInput(input)) throw new Error('invalid snippet')
    return saveSnippet(context.db, input)
  })
  handle(IPC_CHANNELS.snippetsDelete, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid snippet id')
    return deleteSnippet(context.db, id)
  })
  handle(IPC_CHANNELS.draftSave, (_event, draft) => {
    if (!isDraftSaveInput(draft)) throw new Error('invalid draft')
    if (context.consumeTestDraftSaveFailure()) throw new Error('injected draft save failure')
    const account = requireAccount(context)
    const canonical = canonicalizeRendererDraft(context.db, account, draft)
    const prepared =
      canonical.id === null
        ? prepareDraftWithCachedPrimarySignature(context.db, account, canonical)
        : { draft: canonical, defaultSignatureFingerprint: null }
    const now = Date.now()
    const id = saveDraft(context.db, account, prepared.draft, now, prepared.defaultSignatureFingerprint)
    return {
      id,
      draft:
        prepared.draft.id === null
          ? { ...prepared.draft, id, accountId: account, createdAt: now, updatedAt: now }
          : null
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
  handle(IPC_CHANNELS.draftCreateReply, async (_event, threadId, kind, mailbox, sourceMessageId) => {
    if (
      typeof threadId !== 'string' ||
      threadId.length === 0 ||
      (kind !== 'reply' && kind !== 'replyAll' && kind !== 'forward') ||
      (sourceMessageId !== undefined && !nonEmptyString(sourceMessageId))
    ) {
      return null
    }
    const replyMailbox = isConversationMailbox(mailbox) ? mailbox : 'normal'
    const account = requireAccount(context)
    if (sourceMessageId !== undefined) {
      const cached = getConversation(
        context.db,
        account,
        threadId,
        'unavailable',
        replyMailbox,
        sourceMessageId !== undefined
      )
      if (!cached?.messages.some((message) => message.id === sourceMessageId)) return null
    }
    const existing = reopenThreadDraft(context.db, account, threadId, kind, sourceMessageId)
    const shouldUpgradeReplyAll = kind === 'replyAll' && existing?.kind === 'reply'
    if (existing && !shouldUpgradeReplyAll) return existing
    await context.waitForConversation(threadId)
    let conversation = getConversation(
      context.db,
      account,
      threadId,
      'unavailable',
      replyMailbox,
      sourceMessageId !== undefined
    )
    if (
      !conversation ||
      conversation.messages.length === 0 ||
      (sourceMessageId !== undefined &&
        !conversation.messages.some((message) => message.id === sourceMessageId))
    )
      return existing
    if (existing) {
      // Recipient headers are available even when a message body is not. The
      // reused reply already owns its quote, so Reply-All stays local-first and
      // never waits on body hydration merely to add the planned To/Cc set.
      // Upgrade against the draft's original message, even if newer mail arrived.
      const originalSourceId = existing.sourceMessageId ?? sourceMessageId
      if (originalSourceId && !conversation.messages.some((message) => message.id === originalSourceId)) {
        return existing
      }
      const plan = planReply('replyAll', conversation, account, originalSourceId)
      const upgraded = upgradeReplyToReplyAll(context.db, account, existing.id, plan.to, plan.cc)
      context.broadcastMailChanged()
      return upgraded
    }
    if (replySourceMessage(kind, conversation, account, sourceMessageId).bodyState !== 'complete') {
      const provider = context.makeProvider()
      if (provider) {
        await bodyHydrator.request(account, threadId, provider)
        conversation = getConversation(
          context.db,
          account,
          threadId,
          'unavailable',
          replyMailbox,
          sourceMessageId !== undefined
        )
      }
    }
    if (
      !conversation ||
      conversation.messages.length === 0 ||
      (sourceMessageId !== undefined &&
        !conversation.messages.some((message) => message.id === sourceMessageId)) ||
      replySourceMessage(kind, conversation, account, sourceMessageId).bodyState !== 'complete'
    ) {
      return null
    }
    const plan = planReply(kind, conversation, account, sourceMessageId)
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
    const prepared = prepareDraftWithCachedPrimarySignature(context.db, account, input)
    const id = saveDraft(
      context.db,
      account,
      prepared.draft,
      Date.now(),
      prepared.defaultSignatureFingerprint
    )
    context.broadcastMailChanged()
    return getDraft(context.db, account, id)
  })
  handle(IPC_CHANNELS.draftPickAttachments, async (_event, id, paths) => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    if (!Array.isArray(paths) || !paths.every((path) => nonEmptyString(path))) {
      throw new Error('invalid attachments')
    }
    return spoolDraftAttachments(context.db, context.userDataPath, requireAccount(context), id, paths)
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
    return spoolDraftAttachments(context.db, context.userDataPath, requireAccount(context), id, paths)
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
    return removeDraftAttachment(context.db, context.userDataPath, requireAccount(context), id, attachmentId)
  })
  handle(IPC_CHANNELS.draftAddInlineImage, async (_event, id, image) => {
    if (!nonEmptyString(id) || !isDraftInlineImageInput(image)) {
      throw new Error('invalid inline image')
    }
    return addInlineImage(context.db, context.userDataPath, requireAccount(context), id, image)
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
        const spoolRoot = resolve(context.userDataPath, 'outbox', id)
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
      cleanOutboxSpool(context.userDataPath, id)
      void context.draftMirrorExecutor()?.trigger()
    }
    return result
  })
  handle(IPC_CHANNELS.draftDiscard, (_event, id, expectedState = 'composing') => {
    if (!nonEmptyString(id)) throw new Error('invalid draft id')
    if (expectedState !== 'composing' && expectedState !== 'drafted') {
      throw new Error('invalid draft state')
    }
    if (!discardDraft(context.db, requireAccount(context), id, expectedState)) {
      throw new Error('draft is unavailable')
    }
    cleanOutboxSpool(context.userDataPath, id)
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
  handle(IPC_CHANNELS.syncGetInboxReady, () => {
    const syncController = context.syncController()
    if (syncController?.isInboxRecoveryPending()) return false
    const sync = syncController?.getState()
    if (sync?.phase === 'syncing' && (sync.stage === 'metadata' || sync.stage === 'bodies')) return false
    const account = context.currentAccountId()
    if (!account) return false
    const state = context.db
      .prepare(
        `SELECT backfill_cursor, split_metadata_cursor
         FROM sync_state
         WHERE account_id = ?`
      )
      .get(account) as { backfill_cursor: string | null; split_metadata_cursor: string | null } | undefined
    return inboxBackfillReady(state?.backfill_cursor, state?.split_metadata_cursor)
  })
  handle(IPC_CHANNELS.syncRetry, () => {
    context.syncController()?.retry()
    return undefined
  })
  handle(IPC_CHANNELS.mailSearch, (_event, query) => {
    const account = context.currentAccountId()
    if (!account || typeof query !== 'string') {
      return {
        rows: [],
        drafts: [],
        coverage: {
          headersComplete: false,
          headersCapped: false,
          indexComplete: false,
          attachmentFlagsComplete: false,
          bodiesOnDemand: false
        },
        partial: false
      }
    }
    const searchWindow = context.searchWindowOverride()
    return searchThreads(context.db, account, query.slice(0, 1_000), {
      ...(searchWindow === null ? {} : { recentMessageLimit: searchWindow })
    })
  })
  handle(IPC_CHANNELS.mailSearchAll, async (_event, requestId, query) => {
    const account = context.currentAccountId()
    const boundedQuery = typeof query === 'string' ? query.trim().slice(0, 1_000) : ''
    if (!account || !nonEmptyString(requestId) || requestId.length > 128 || !boundedQuery) {
      return { status: 'error', message: 'Enter a search before searching Gmail' }
    }
    const provider = context.makeServerSearchProvider()
    if (!provider) {
      return { status: 'auth-required', message: 'Reconnect Google to search Gmail' }
    }
    const controller = new AbortController()
    activeServerSearches.get(requestId)?.abort()
    activeServerSearches.set(requestId, controller)
    let storeChanged = false
    try {
      const result = await context.trackForegroundProviderWork(account, () =>
        searchAllGmail(context.db, account, provider, boundedQuery, {
          shouldContinue: () => context.currentAccountId() === account,
          signal: controller.signal,
          recentMessageLimit: context.searchWindowOverride() ?? undefined,
          onStoreChanged: () => {
            storeChanged = true
          }
        })
      )
      return { status: 'ok', ...result }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'ok', rows: [], quotaWaitMs: 0 }
      return serverSearchFailure(error)
    } finally {
      if (storeChanged && context.currentAccountId() === account) {
        context.broadcastMailChanged(requestId)
      }
      if (activeServerSearches.get(requestId) === controller) activeServerSearches.delete(requestId)
    }
  })
  handle(IPC_CHANNELS.mailCancelSearchAll, (_event, requestId) => {
    if (nonEmptyString(requestId) && requestId.length <= 128) {
      activeServerSearches.get(requestId)?.abort()
    }
    return undefined
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
  handle(IPC_CHANNELS.mailListThreads, (_event, request) => {
    const account = context.currentAccountId()
    const input = isThreadListRequest(request) ? request : null
    if (!account || !input) return threadPage([])
    const cursor = input.cursor ?? null
    const limit = input.threadId ? 1 : THREAD_PAGE_SIZE + 1
    if (input.view === 'label') {
      return threadPage(listLabelThreads(context.db, account, input.labelId, limit, cursor, input.threadId))
    }
    if (input.view === 'inbox') {
      if (!input.splitId) {
        return threadPage(listInboxThreads(context.db, account, limit, cursor, undefined, input.threadId))
      }
      return context.db.transaction(() => {
        const revision = splitRevision(context.db, account)
        return threadPage(
          listInboxThreads(context.db, account, limit, cursor, input.splitId, input.threadId),
          false,
          revision
        )
      })()
    }
    if (input.view === 'snoozed') {
      return threadPage(listSnoozedThreads(context.db, account, limit, cursor, input.threadId), true)
    }
    return threadPage(listMailboxThreads(context.db, account, input.view, limit, cursor, input.threadId))
  })
  handle(IPC_CHANNELS.mailListLabels, () => {
    const account = context.currentAccountId()
    return account ? listUserLabels(context.db, account) : []
  })
  handle(IPC_CHANNELS.mailGetMailboxCounts, () => {
    const account = context.currentAccountId()
    return account
      ? context.mailboxCounts(account)
      : { inbox: 0, allMail: 0, sent: 0, starred: 0, snoozed: 0, spam: 0, trash: 0 }
  })
  handle(IPC_CHANNELS.mailGetUnreadCount, () => {
    const account = context.currentAccountId()
    return account ? countInboxUnread(context.db, account) : 0
  })
  handle(IPC_CHANNELS.splitsGetState, () => {
    const account = context.currentAccountId()
    if (!account || (context.testUserData && !hasSplitSetup(context.db, account))) {
      return { revision: 0, splits: [], restorablePresetIds: [] }
    }
    return context.splitState(account)
  })
  handle(IPC_CHANNELS.splitsGetThreadLocation, (_event, threadId) => {
    const account = context.currentAccountId()
    if (
      !account ||
      !nonEmptyString(threadId) ||
      (context.testUserData && !hasSplitSetup(context.db, account))
    ) {
      return null
    }
    return splitLocationForThread(context.db, account, threadId)
  })
  handle(IPC_CHANNELS.splitsSave, (_event, input) => {
    if (!isSaveSplitInput(input)) throw new Error('invalid split')
    const state = saveSplit(context.db, requireAccount(context), input)
    context.broadcastMailChanged()
    return state
  })
  handle(IPC_CHANNELS.splitsSetNotify, (_event, id, notify) => {
    if (!nonEmptyString(id) || typeof notify !== 'boolean') throw new Error('invalid split notification')
    const state = setSplitNotify(context.db, requireAccount(context), id, notify)
    context.broadcastMailChanged()
    return state
  })
  handle(IPC_CHANNELS.splitsDelete, (_event, id) => {
    if (!nonEmptyString(id)) throw new Error('invalid split')
    const state = deleteSplit(context.db, requireAccount(context), id)
    context.broadcastMailChanged()
    return state
  })
  handle(IPC_CHANNELS.splitsReorder, (_event, input) => {
    if (!isReorderSplitsInput(input)) throw new Error('invalid split order')
    const state = reorderSplits(context.db, requireAccount(context), input)
    context.broadcastMailChanged()
    return state
  })
  handle(IPC_CHANNELS.splitsRestorePreset, (_event, id) => {
    if (typeof id !== 'string' || !(SPLIT_PRESET_IDS as readonly string[]).includes(id)) {
      throw new Error('invalid split preset')
    }
    const state = restoreSplitPreset(context.db, requireAccount(context), id as SplitPresetId)
    context.broadcastMailChanged()
    return state
  })
  handle(IPC_CHANNELS.mailGetConversation, async (_event, threadId, allowHydration, mailbox) => {
    if (typeof threadId !== 'string') return null
    await context.waitForConversation(threadId)
    const account = context.currentAccountId()
    if (!account) return null
    const attemptState = bodyHydrator.state(account, threadId)
    const conversation = getConversationForDisplay(
      context.db,
      account,
      threadId,
      attemptState === 'idle' ? idleMissingBodyState(context.isSeeded()) : attemptState,
      isConversationMailbox(mailbox) ? mailbox : 'normal',
      true
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
        context.downloadsPath,
        request.filename,
        Buffer.from(resolved.data, 'base64url')
      )
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
  handle(IPC_CHANNELS.mailListRemoteImageOverrides, () => listRemoteImageOverrides(context.db))
  handle(IPC_CHANNELS.mailRemoveRemoteImageOverride, (_event, address) => {
    if (!nonEmptyString(address)) throw new Error('invalid sender address')
    removeRemoteImageOverride(context.db, address)
    context.publishRemoteImagePolicy()
    return listRemoteImageOverrides(context.db)
  })
  handle(IPC_CHANNELS.mailAllowRemoteImagesFromSender, (_event, messageId) => {
    if (!nonEmptyString(messageId)) throw new Error('invalid message id')
    // The override's subject is the sender the *store* holds for this message
    // — the frame's markup and the renderer's display text never decide (T33).
    const account = requireAccount(context)
    const sender = resolveMessageSender(context.db, account, messageId)
    if (!sender) throw new Error('unknown message sender')
    addRemoteImageOverride(context.db, sender)
    context.publishRemoteImagePolicy()
    return { sender, overrides: listRemoteImageOverrides(context.db) }
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
        const { thread, persisted } = await fetchAndCacheThread(
          context.db,
          accountId,
          provider,
          request.threadId,
          {
            format: 'full',
            shouldPersist: () => context.currentAccountId() === accountId
          }
        )
        if (context.currentAccountId() !== accountId) return false
        if (!persisted) return false
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
  handle(IPC_CHANNELS.accountsGetStatuses, () => context.accountStatuses())
  handle(IPC_CHANNELS.mailGetPendingActionCount, () => {
    const account = context.currentAccountId()
    return account ? pendingActionCount(context.db, account) : 0
  })
  handle(IPC_CHANNELS.mailGetActionQueueStatus, () => {
    const account = context.currentAccountId()
    return account ? actionQueueStatus(context.db, account) : { pending: 0, paused: 0, authPaused: false }
  })
  return {
    async invoke<K extends InvokeChannel>(channel: K, args: unknown[]): Promise<InvokeChannels[K]['result']> {
      const handler = registered.get(channel)
      if (!handler) throw new Error(`unsupported utility operation: ${channel}`)
      return (await handler(undefined, ...args)) as InvokeChannels[K]['result']
    },
    stop: () => {
      for (const controller of activeServerSearches.values()) controller.abort()
      activeServerSearches.clear()
      bodyHydrator.stop()
    }
  }
}

function requireAccount(context: ServiceHandlerContext): string {
  const account = context.currentAccountId()
  if (!account) throw new Error('not signed in')
  return account
}
