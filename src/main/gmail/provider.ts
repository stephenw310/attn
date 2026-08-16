import type {
  DraftPage,
  GetThreadOptions,
  HistoryPage,
  ListThreadIdsOptions,
  MailProvider,
  ProviderDraft,
  ProviderLabel,
  ProviderProfile,
  ProviderRequestOptions,
  ProviderSendResult,
  RfcMessageMatch,
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

  async saveDraft(
    draft: { id: string | null; raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string> {
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const requestOptions = { retryTransient: false, signal: options?.signal }
    const result = draft.id
      ? await this.client.put<{ id: string }>(`/drafts/${encodeURIComponent(draft.id)}`, body, requestOptions)
      : await this.client.post<{ id: string }>('/drafts', body, requestOptions)
    return result.id
  }

  async createDraft(
    draft: { raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string> {
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const result = await this.client.post<{ id: string }>('/drafts', body, {
      retryTransient: false,
      signal: options?.signal
    })
    return result.id
  }

  async updateDraft(
    draft: { id: string; raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string> {
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const result = await this.client.put<{ id: string }>(`/drafts/${encodeURIComponent(draft.id)}`, body, {
      retryTransient: false,
      signal: options?.signal
    })
    return result.id
  }

  async deleteDraft(id: string, options?: ProviderRequestOptions): Promise<void> {
    await this.client.delete(`/drafts/${encodeURIComponent(id)}`, {
      retryTransient: false,
      signal: options?.signal
    })
  }

  async listDrafts(pageToken?: string, options?: ProviderRequestOptions): Promise<DraftPage> {
    const result = await this.client.get<{
      drafts?: { id: string; message?: { id?: string; threadId?: string } }[]
      nextPageToken?: string
    }>('/drafts', { maxResults: '100', ...(pageToken ? { pageToken } : {}) }, options)
    return {
      drafts: (result.drafts ?? []).map((draft) => ({
        id: draft.id,
        messageId: draft.message?.id,
        threadId: draft.message?.threadId
      })),
      nextPageToken: result.nextPageToken
    }
  }

  getDraft(id: string, options?: ProviderRequestOptions): Promise<ProviderDraft> {
    return this.client.get<ProviderDraft>(`/drafts/${encodeURIComponent(id)}`, { format: 'full' }, options)
  }

  sendDraft(id: string, options?: ProviderRequestOptions): Promise<ProviderSendResult> {
    return this.client.post<ProviderSendResult>(
      '/drafts/send',
      { id },
      {
        retryTransient: false,
        signal: options?.signal
      }
    )
  }

  async findByRfcId(rfcMessageId: string, options?: ProviderRequestOptions): Promise<RfcMessageMatch | null> {
    const messageId = rfcMessageId.trim().replace(/[\r\n]/g, '')
    if (!messageId) return null
    const query = `rfc822msgid:${messageId}`
    const drafts = await this.client.get<{
      messages?: { id: string; threadId?: string }[]
    }>('/messages', { q: `in:drafts ${query}`, maxResults: '10', includeSpamTrash: 'true' }, options)
    const messages = await this.client.get<{
      messages?: { id: string; threadId?: string }[]
    }>('/messages', { q: query, maxResults: '10', includeSpamTrash: 'true' }, options)
    const candidates = new Map(
      [...(drafts.messages ?? []), ...(messages.messages ?? [])].map((message) => [message.id, message])
    )
    if (candidates.size > 0) {
      let pageToken: string | undefined
      do {
        const page = await this.listDrafts(pageToken, options)
        for (const draft of page.drafts) {
          const message = draft.messageId ? candidates.get(draft.messageId) : undefined
          if (message) {
            return {
              kind: 'draft',
              draftId: draft.id,
              messageId: message.id,
              ...(message.threadId ? { threadId: message.threadId } : {})
            }
          }
        }
        pageToken = page.nextPageToken
      } while (pageToken)
    }

    for (const candidate of messages.messages ?? []) {
      try {
        const message = await this.client.get<{
          id: string
          threadId?: string
          labelIds?: string[]
        }>(`/messages/${encodeURIComponent(candidate.id)}`, { format: 'minimal' }, options)
        const labels = new Set(message.labelIds ?? [])
        if (!labels.has('SENT') || labels.has('DRAFT')) continue
        return {
          kind: 'message',
          messageId: message.id,
          ...((message.threadId ?? candidate.threadId)
            ? { threadId: message.threadId ?? candidate.threadId }
            : {})
        }
      } catch (error) {
        if (!(error instanceof GmailApiError) || error.status !== 404) throw error
      }
    }
    return null
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
    return this.client.get<GmailThread>(
      `/threads/${encodeURIComponent(id)}`,
      {
        format,
        ...(format === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {})
      },
      { signal: options.signal }
    )
  }

  async getAttachmentData(
    messageId: string,
    attachmentId: string,
    options?: ProviderRequestOptions
  ): Promise<string | undefined> {
    try {
      return (
        await this.client.get<{ data?: string }>(
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
          undefined,
          { signal: options?.signal }
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
