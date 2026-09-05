import { RFC_MESSAGE_LOOKUP_LIMIT } from '../../shared/outboxTuning'
import type {
  DraftPage,
  GetThreadOptions,
  HistoryPage,
  ListThreadIdsOptions,
  MailProvider,
  ProviderDraft,
  ProviderDraftUpdate,
  ProviderLabel,
  ProviderProfile,
  ProviderRequestOptions,
  ProviderSendAs,
  ProviderSendResult,
  RfcMessageMatch,
  ThreadIdPage
} from '../sync/provider'
import { GMAIL_DRAFT_PAGE_SIZE, GMAIL_HISTORY_PAGE_SIZE, GMAIL_THREAD_PAGE_SIZE } from '../sync/tuning'
import { GmailApiError, type GmailClient } from './client'
import type { GmailThread } from './parse'

const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Reply-To',
  'Subject',
  'List-Id',
  'Message-ID',
  'References',
  'In-Reply-To'
]

export class GmailMailProvider implements MailProvider {
  constructor(private readonly client: GmailClient) {}

  async modifyThread(threadId: string, add: string[], remove: string[]): Promise<void> {
    await this.client.post(
      `/threads/${encodeURIComponent(threadId)}/modify`,
      {
        addLabelIds: add,
        removeLabelIds: remove
      },
      { priority: 'action' }
    )
  }

  async createDraft(
    draft: { raw: string; threadId?: string | null },
    options?: ProviderRequestOptions
  ): Promise<string> {
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const result = await this.client.post<{ id: string }>('/drafts', body, {
      retryTransient: false,
      signal: options?.signal,
      priority: options?.priority ?? 'send'
    })
    return result.id
  }

  async updateDraft(draft: ProviderDraftUpdate, options?: ProviderRequestOptions): Promise<string> {
    if (draft.mime) {
      const result = await this.client.multipartUpload<{ id: string }>(
        'PUT',
        `/drafts/${encodeURIComponent(draft.id)}`,
        { message: draft.threadId ? { threadId: draft.threadId } : {} },
        {
          mimeType: 'message/rfc822',
          sizeBytes: draft.mime.sizeBytes,
          endsWithCrlf: true,
          open: draft.mime.open
        },
        { signal: options?.signal, priority: options?.priority ?? 'foreground' }
      )
      return result.id
    }
    if (draft.raw === undefined) throw new Error('Draft update content is required')
    const body = { message: { raw: draft.raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }
    const result = await this.client.put<{ id: string }>(`/drafts/${encodeURIComponent(draft.id)}`, body, {
      retryTransient: false,
      signal: options?.signal,
      priority: options?.priority ?? 'foreground'
    })
    return result.id
  }

  async deleteDraft(id: string, options?: ProviderRequestOptions): Promise<void> {
    await this.client.delete(`/drafts/${encodeURIComponent(id)}`, {
      retryTransient: false,
      signal: options?.signal,
      priority: options?.priority ?? 'foreground'
    })
  }

  async listDrafts(pageToken?: string, options?: ProviderRequestOptions): Promise<DraftPage> {
    const result = await this.client.get<{
      drafts?: { id: string; message?: { id?: string; threadId?: string } }[]
      nextPageToken?: string
    }>('/drafts', { maxResults: String(GMAIL_DRAFT_PAGE_SIZE), ...(pageToken ? { pageToken } : {}) }, options)
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
        signal: options?.signal,
        priority: options?.priority ?? 'send'
      }
    )
  }

  async findByRfcId(rfcMessageId: string, options?: ProviderRequestOptions): Promise<RfcMessageMatch | null> {
    const storedMessageId = rfcMessageId.trim().replace(/[\r\n]/g, '')
    const messageId =
      storedMessageId.startsWith('<') && storedMessageId.endsWith('>')
        ? storedMessageId.slice(1, -1)
        : storedMessageId
    if (!messageId) return null
    const query = `rfc822msgid:${messageId}`
    const drafts = await this.client.get<{
      messages?: { id: string; threadId?: string }[]
    }>(
      '/messages',
      { q: `in:drafts ${query}`, maxResults: String(RFC_MESSAGE_LOOKUP_LIMIT), includeSpamTrash: 'true' },
      options
    )
    const messages = await this.client.get<{
      messages?: { id: string; threadId?: string }[]
    }>(
      '/messages',
      { q: query, maxResults: String(RFC_MESSAGE_LOOKUP_LIMIT), includeSpamTrash: 'true' },
      options
    )
    const draftCandidates = new Map((drafts.messages ?? []).map((message) => [message.id, message]))
    const searchedDraftMessageIds = new Set<string>()
    const findDraftCandidate = async (): Promise<RfcMessageMatch | null> => {
      const pendingIds = new Set(
        [...draftCandidates.keys()].filter((messageId) => !searchedDraftMessageIds.has(messageId))
      )
      if (pendingIds.size === 0) return null
      for (const messageId of pendingIds) searchedDraftMessageIds.add(messageId)
      let pageToken: string | undefined
      do {
        const page = await this.listDrafts(pageToken, options)
        for (const draft of page.drafts) {
          const message =
            draft.messageId && pendingIds.has(draft.messageId)
              ? draftCandidates.get(draft.messageId)
              : undefined
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
      return null
    }
    const scopedDraft = await findDraftCandidate()
    if (scopedDraft) return scopedDraft

    for (const candidate of messages.messages ?? []) {
      try {
        const message = await this.client.get<{
          id: string
          threadId?: string
          labelIds?: string[]
        }>(`/messages/${encodeURIComponent(candidate.id)}`, { format: 'minimal' }, options)
        const labels = new Set(message.labelIds ?? [])
        if (labels.has('DRAFT')) {
          draftCandidates.set(candidate.id, candidate)
          continue
        }
        if (!labels.has('SENT')) continue
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
    return findDraftCandidate()
  }

  getProfile(options?: ProviderRequestOptions): Promise<ProviderProfile> {
    return this.client.get('/profile', undefined, options)
  }

  getSendAs(email: string, options?: ProviderRequestOptions): Promise<ProviderSendAs> {
    return this.client.get(`/settings/sendAs/${encodeURIComponent(email)}`, undefined, options)
  }

  async listLabels(options?: ProviderRequestOptions): Promise<ProviderLabel[]> {
    const result = await this.client.get<{ labels?: ProviderLabel[] }>('/labels', undefined, options)
    return result.labels ?? []
  }

  async listThreadIds(options: ListThreadIdsOptions = {}): Promise<ThreadIdPage> {
    const params: Record<string, string | string[]> = { maxResults: String(GMAIL_THREAD_PAGE_SIZE) }
    if (options.q) params.q = options.q
    if (options.labelIds?.length) params.labelIds = [...options.labelIds]
    if (options.pageToken) params.pageToken = options.pageToken
    if (options.includeSpamTrash) params.includeSpamTrash = 'true'
    const result = await this.client.get<{
      threads?: { id: string }[]
      nextPageToken?: string
      resultSizeEstimate?: number
    }>('/threads', params, { signal: options.signal, priority: options.priority })
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
      { signal: options.signal, priority: options.priority }
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
          { signal: options?.signal, priority: options?.priority }
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
      maxResults: String(GMAIL_HISTORY_PAGE_SIZE),
      historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']
    }
    if (pageToken) params.pageToken = pageToken
    const result = await this.client.get<{
      history?: HistoryPage['history']
      historyId: string
      nextPageToken?: string
    }>('/history', params, { priority: 'polling' })
    return {
      history: result.history ?? [],
      historyId: result.historyId,
      nextPageToken: result.nextPageToken
    }
  }

  quotaMetrics(): ReturnType<GmailClient['quotaMetrics']> {
    return this.client.quotaMetrics()
  }
}
