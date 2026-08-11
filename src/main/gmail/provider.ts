import type { MailProvider } from '../sync/provider'
import type { GmailClient } from './client'

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
}
