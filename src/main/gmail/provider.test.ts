import { describe, expect, it, vi } from 'vitest'
import type { GmailClient } from './client'
import { GmailMailProvider } from './provider'

describe('GmailMailProvider.listThreadIds', () => {
  it('passes explicit labels without silently adding INBOX', async () => {
    const get = vi.fn(async () => ({ threads: [{ id: 'sent-1' }] }))
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(
      provider.listThreadIds({ labelIds: ['SENT'], q: 'newer_than:12m', pageToken: 'next' })
    ).resolves.toEqual({ threadIds: ['sent-1'], nextPageToken: undefined })
    expect(get).toHaveBeenCalledWith('/threads', {
      maxResults: '100',
      q: 'newer_than:12m',
      labelIds: ['SENT'],
      pageToken: 'next'
    })
  })
})
