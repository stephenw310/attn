import type {
  GetThreadOptions,
  HistoryPage,
  MailProvider,
  ProviderLabel,
  ProviderProfile,
  ThreadIdPage
} from '../sync/provider'
import { GmailApiError, type GmailClient } from './client'
import type { GmailThread } from './parse'

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Subject']

export class GmailMailProvider implements MailProvider {
  constructor(private readonly client: GmailClient) {}

  async modifyThread(threadId: string, add: string[], remove: string[]): Promise<void> {
    await this.client.post(`/threads/${encodeURIComponent(threadId)}/modify`, {
      addLabelIds: add,
      removeLabelIds: remove
    })
  }

  async trashThread(threadId: string): Promise<void> {
    await this.client.post(`/threads/${encodeURIComponent(threadId)}/trash`, {})
  }

  async untrashThread(threadId: string): Promise<void> {
    await this.client.post(`/threads/${encodeURIComponent(threadId)}/untrash`, {})
  }

  getProfile(): Promise<ProviderProfile> {
    return this.client.get('/profile')
  }

  async listLabels(): Promise<ProviderLabel[]> {
    const result = await this.client.get<{ labels?: ProviderLabel[] }>('/labels')
    return result.labels ?? []
  }

  async listThreadIds(q: string, pageToken?: string): Promise<ThreadIdPage> {
    const params: Record<string, string> = { labelIds: 'INBOX', maxResults: '100' }
    if (q) params.q = q
    if (pageToken) params.pageToken = pageToken
    const result = await this.client.get<{
      threads?: { id: string }[]
      nextPageToken?: string
    }>('/threads', params)
    return {
      threadIds: (result.threads ?? []).map((thread) => thread.id),
      nextPageToken: result.nextPageToken
    }
  }

  getThread(id: string, options: GetThreadOptions = {}): Promise<GmailThread> {
    const format = options.format ?? 'full'
    return this.client.get<GmailThread>(`/threads/${encodeURIComponent(id)}`, {
      format,
      ...(format === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {})
    })
  }

  async getAttachmentData(messageId: string, attachmentId: string): Promise<string | undefined> {
    try {
      return (
        await this.client.get<{ data?: string }>(
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
        )
      ).data
    } catch (error) {
      // The message or attachment can disappear between thread and part fetches.
      if (error instanceof GmailApiError && error.status === 404) return undefined
      throw error
    }
  }

  async listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    const params: Record<string, string | string[]> = {
      startHistoryId,
      maxResults: '500',
      historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']
    }
    if (pageToken) params.pageToken = pageToken
    const result = await this.client.get<{
      history?: HistoryPage['history']
      historyId: string
      nextPageToken?: string
    }>('/history', params)
    return {
      history: result.history ?? [],
      historyId: result.historyId,
      nextPageToken: result.nextPageToken
    }
  }
}
