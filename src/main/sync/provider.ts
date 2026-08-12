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

export interface MailActionProvider {
  modifyThread(threadId: string, add: string[], remove: string[]): Promise<void>
  trashThread(threadId: string): Promise<void>
  untrashThread(threadId: string): Promise<void>
}

export interface MailProvider extends MailActionProvider {
  getProfile(): Promise<ProviderProfile>
  listLabels(): Promise<ProviderLabel[]>
  listThreadIds(q: string, pageToken?: string): Promise<ThreadIdPage>
  getThread(id: string): Promise<GmailThread>
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>
}
