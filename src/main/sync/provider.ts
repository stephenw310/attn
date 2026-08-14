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
  saveDraft?(draft: { id: string | null; raw: string }): Promise<string>
}

export interface MailProvider extends MailActionProvider {
  getProfile(): Promise<ProviderProfile>
  listLabels(): Promise<ProviderLabel[]>
  listThreadIds(options?: ListThreadIdsOptions): Promise<ThreadIdPage>
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
  getAttachmentData(messageId: string, attachmentId: string): Promise<string | undefined>
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>
}
