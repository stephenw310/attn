import type { GmailMessage, GmailThread } from '../gmail/parse'

export interface ProviderProfile {
  emailAddress: string
  historyId: string
  messagesTotal?: number
  threadsTotal?: number
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

export interface ProviderDraftSummary {
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
}

export interface HistoryMessageEvent {
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
}

export interface ProviderRequestOptions {
  signal?: AbortSignal
}

export interface MailActionProvider {
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>
  trashThread(threadId: string): Promise<void>
  untrashThread(threadId: string): Promise<void>
  /** Optional for test providers predating M2; production providers implement it. */
  saveDraft?(
    draft: { id: string | null; raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string>
  /** A single, non-retried remote create for the exactly-once outbox protocol. */
  createDraft?(
    draft: { raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string>
  updateDraft?(
    draft: { id: string; raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string>
  deleteDraft?(id: string, options?: ProviderRequestOptions): Promise<void>
  getAttachmentData?(
    messageId: string,
    attachmentId: string,
    options?: ProviderRequestOptions
  ): Promise<string | undefined>
}

export interface MailProvider extends MailActionProvider {
  getProfile(): Promise<ProviderProfile>
  listLabels(): Promise<ProviderLabel[]>
  listThreadIds(options?: ListThreadIdsOptions): Promise<ThreadIdPage>
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
  getAttachmentData(
    messageId: string,
    attachmentId: string,
    options?: ProviderRequestOptions
  ): Promise<string | undefined>
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>
  listDrafts(pageToken?: string, options?: ProviderRequestOptions): Promise<DraftPage>
  getDraft(id: string, options?: ProviderRequestOptions): Promise<ProviderDraft>
  /** Optional only for narrow test providers; production Gmail implements both. */
  sendDraft?(id: string, options?: ProviderRequestOptions): Promise<ProviderSendResult>
  findByRfcId?(rfcMessageId: string, options?: ProviderRequestOptions): Promise<RfcMessageMatch | null>
}
