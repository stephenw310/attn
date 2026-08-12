import type {
  HistoryPage,
  MailProvider,
  ProviderLabel,
  ProviderProfile,
  ThreadIdPage
} from '../sync/provider'
import { GmailApiError, type GmailClient } from './client'
import type { GmailPart, GmailThread } from './parse'

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
    const params: Record<string, string> = { labelIds: 'INBOX', maxResults: '100', q }
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

  async getThread(id: string): Promise<GmailThread> {
    const thread = await this.client.get<GmailThread>(`/threads/${encodeURIComponent(id)}`, {
      format: 'full'
    })
    await this.hydrateExternalTextParts(thread)
    return thread
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

  private async hydrateExternalTextParts(thread: GmailThread): Promise<void> {
    for (const message of thread.messages ?? []) {
      const parts = externalTextParts(message.payload)
      for (const part of parts) {
        const attachmentId = part.body?.attachmentId
        if (!attachmentId) continue
        try {
          const attachment = await this.client.get<{ data?: string }>(
            `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachmentId)}`
          )
          if (attachment.data && part.body) part.body.data = attachment.data
        } catch (error) {
          // The message or attachment can disappear between thread and part fetches.
          if (error instanceof GmailApiError && error.status === 404) continue
          throw error
        }
      }
    }
  }
}

function externalTextParts(payload: GmailPart | undefined): GmailPart[] {
  const result: GmailPart[] = []
  const visit = (part: GmailPart): void => {
    if (
      !part.filename &&
      !part.body?.data &&
      part.body?.attachmentId &&
      (part.mimeType === 'text/plain' || part.mimeType === 'text/html')
    ) {
      result.push(part)
    }
    part.parts?.forEach(visit)
  }
  if (payload) visit(payload)
  return result
}
