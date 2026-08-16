import type {
  DraftPage,
  GetThreadOptions,
  HistoryPage,
  ListThreadIdsOptions,
  MailProvider,
  ProviderDraft,
  ProviderLabel,
  ProviderProfile,
  ThreadIdPage
} from '../sync/provider'
import { GmailApiError, type GmailClient } from './client'
import type { GmailThread } from './parse'

const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Reply-To',
  'Subject',
  'Message-ID',
  'References',
  'In-Reply-To'
]

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

  async saveDraft(draft: { id: string | null; raw: string; threadId?: string | null }): Promise<string> {
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const result = draft.id
      ? await this.client.put<{ id: string }>(`/drafts/${encodeURIComponent(draft.id)}`, body)
      : await this.client.post<{ id: string }>('/drafts', body)
    return result.id
  }

  async deleteDraft(id: string): Promise<void> {
    await this.client.delete(`/drafts/${encodeURIComponent(id)}`)
  }

  async listDrafts(pageToken?: string): Promise<DraftPage> {
    const result = await this.client.get<{
      drafts?: { id: string; message?: { id?: string; threadId?: string } }[]
      nextPageToken?: string
    }>('/drafts', { maxResults: '100', ...(pageToken ? { pageToken } : {}) })
    return {
      drafts: (result.drafts ?? []).map((draft) => ({
        id: draft.id,
        messageId: draft.message?.id,
        threadId: draft.message?.threadId
      })),
      nextPageToken: result.nextPageToken
    }
  }

  getDraft(id: string): Promise<ProviderDraft> {
    return this.client.get<ProviderDraft>(`/drafts/${encodeURIComponent(id)}`, { format: 'full' })
  }

  getProfile(): Promise<ProviderProfile> {
    return this.client.get('/profile')
  }

  async listLabels(): Promise<ProviderLabel[]> {
    const result = await this.client.get<{ labels?: ProviderLabel[] }>('/labels')
    return result.labels ?? []
  }

  async listThreadIds(options: ListThreadIdsOptions = {}): Promise<ThreadIdPage> {
    const params: Record<string, string | string[]> = { maxResults: '100' }
    if (options.q) params.q = options.q
    if (options.labelIds?.length) params.labelIds = [...options.labelIds]
    if (options.pageToken) params.pageToken = options.pageToken
    const result = await this.client.get<{
      threads?: { id: string }[]
      nextPageToken?: string
      resultSizeEstimate?: number
    }>('/threads', params)
    return {
      threadIds: (result.threads ?? []).map((thread) => thread.id),
      nextPageToken: result.nextPageToken,
      resultSizeEstimate: result.resultSizeEstimate
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
