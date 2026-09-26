import type { GmailMessage, GmailThread } from '../gmail/parse'

export interface ProviderProfile {
  emailAddress: string
  historyId: string
  messagesTotal?: number
  threadsTotal?: number
}

export interface ProviderSendAs {
  sendAsEmail: string
  displayName?: string
  /** Gmail's primary HTML signature for this address. */
  signature?: string
  isPrimary?: boolean
  isDefault?: boolean
  replyToAddress?: string
  verificationStatus?: string
}

export interface ProviderLabel {
  id: string
  name: string
  type: string
}

export interface ThreadIdPage {
  threadIds: string[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

interface ProviderDraftSummary {
  id: string
  messageId?: string
  threadId?: string
}

export interface DraftPage {
  drafts: ProviderDraftSummary[]
  nextPageToken?: string
}

export interface ProviderDraft {
  id: string
  message: GmailMessage
}

export interface ProviderSendResult {
  id: string
  threadId: string
}

export type RfcMessageMatch =
  | { kind: 'draft'; draftId: string; messageId: string; threadId?: string }
  | { kind: 'message'; messageId: string; threadId?: string }

export interface ListThreadIdsOptions {
  q?: string
  labelIds?: readonly string[]
  pageToken?: string
  /** Gmail excludes SPAM/TRASH from listings unless asked, even when labelIds targets them. */
  includeSpamTrash?: boolean
  signal?: AbortSignal
  priority?: ProviderRequestPriority
}

interface HistoryMessageEvent {
  message: GmailMessage
  labelIds?: string[]
}

export interface HistoryRecord {
  id: string
  messages?: GmailMessage[]
  messagesAdded?: HistoryMessageEvent[]
  messagesDeleted?: HistoryMessageEvent[]
  labelsAdded?: HistoryMessageEvent[]
  labelsRemoved?: HistoryMessageEvent[]
}

export interface HistoryPage {
  history: HistoryRecord[]
  historyId: string
  nextPageToken?: string
}

export interface GetThreadOptions {
  format?: 'full' | 'metadata'
  signal?: AbortSignal
  priority?: ProviderRequestPriority
}

type ProviderRequestPriority = 'send' | 'action' | 'polling' | 'foreground' | 'background'

export interface ProviderRequestOptions {
  signal?: AbortSignal
  priority?: ProviderRequestPriority
}

interface ProviderQuotaMetrics {
  requests: number
  units: number
  waitMs: number
}

export interface ProviderMimeUpload {
  sizeBytes: number
  open: () => AsyncIterable<Uint8Array>
}

export type ProviderDraftUpdate =
  | {
      id: string
      raw: string
      mime?: never
      threadId?: string | null
    }
  | {
      id: string
      raw?: never
      mime: ProviderMimeUpload
      threadId?: string | null
    }

export interface MailActionProvider {
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>
}

/** Draft operations implemented by Gmail and required by the mirror. */
export interface DraftProvider {
  /** A single, non-retried remote create for the exactly-once outbox protocol. */
  createDraft(
    draft: { raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string>
  updateDraft(draft: ProviderDraftUpdate, options?: ProviderRequestOptions): Promise<string>
  deleteDraft(id: string, options?: ProviderRequestOptions): Promise<void>
  /** Needed to re-read attachment locators, which rotate on every draft rewrite. */
  getDraft(id: string, options?: ProviderRequestOptions): Promise<ProviderDraft>
  getAttachmentData(
    messageId: string,
    attachmentId: string,
    options?: ProviderRequestOptions
  ): Promise<string | undefined>
}

export interface MailProvider extends MailActionProvider, DraftProvider {
  getProfile(options?: ProviderRequestOptions): Promise<ProviderProfile>
  /** Optional only for narrow test providers; production uses it to build the outgoing From header. */
  listSendAs?(options?: ProviderRequestOptions): Promise<ProviderSendAs[]>
  getSendAs?(email: string, options?: ProviderRequestOptions): Promise<ProviderSendAs>
  listLabels(options?: ProviderRequestOptions): Promise<ProviderLabel[]>
  listThreadIds(options?: ListThreadIdsOptions): Promise<ThreadIdPage>
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>
  listDrafts(pageToken?: string, options?: ProviderRequestOptions): Promise<DraftPage>
  /** Optional only for narrow test providers; production Gmail implements both. */
  sendDraft?(id: string, options?: ProviderRequestOptions): Promise<ProviderSendResult>
  findByRfcId?(rfcMessageId: string, options?: ProviderRequestOptions): Promise<RfcMessageMatch | null>
  /** Optional on narrow test providers; production exposes limiter evidence. */
  quotaMetrics?(): ProviderQuotaMetrics
}
