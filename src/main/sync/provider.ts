import type { GmailMessage, GmailThread } from '../gmail/parse'

export interface ProviderProfile {
  emailAddress: string
  historyId: string
}

export interface ProviderLabel {
  id: string
  name: string
  type: string
}

export interface ThreadIdPage {
  threadIds: string[]
  nextPageToken?: string
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
}

export interface MailActionProvider {
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>
  trashThread(threadId: string): Promise<void>
  untrashThread(threadId: string): Promise<void>
  /** Optional for test providers predating M2; production providers implement it. */
  saveDraft?(draft: { id: string | null; raw: string; threadId?: string | null }): Promise<string>
  /** A single, non-retried remote create for the exactly-once outbox protocol. */
  createDraft?(draft: { raw: string; threadId?: string | null }): Promise<string>
  updateDraft?(draft: { id: string; raw: string; threadId?: string | null }): Promise<string>
  deleteDraft?(id: string): Promise<void>
  getAttachmentData?(messageId: string, attachmentId: string): Promise<string | undefined>
}

export interface MailProvider extends MailActionProvider {
  getProfile(): Promise<ProviderProfile>
  listLabels(): Promise<ProviderLabel[]>
  listThreadIds(options?: ListThreadIdsOptions): Promise<ThreadIdPage>
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
  getAttachmentData(messageId: string, attachmentId: string): Promise<string | undefined>
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>
  listDrafts(pageToken?: string): Promise<DraftPage>
  getDraft(id: string): Promise<ProviderDraft>
  /** Optional only for narrow test providers; production Gmail implements both. */
  sendDraft?(id: string): Promise<ProviderSendResult>
  findByRfcId?(rfcMessageId: string): Promise<RfcMessageMatch | null>
}
