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

describe('GmailMailProvider.saveDraft', () => {
  it('creates a Gmail draft without exposing a send endpoint', async () => {
    const post = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)

    await expect(provider.saveDraft({ id: null, raw: 'cmF3' })).resolves.toBe('gmail-draft-1')
    expect(post).toHaveBeenCalledWith('/drafts', { message: { raw: 'cmF3' } })
  })

  it('updates the known Gmail draft id', async () => {
    const put = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ put } as unknown as GmailClient)

    await expect(provider.saveDraft({ id: 'gmail-draft-1', raw: 'bmV4dA' })).resolves.toBe('gmail-draft-1')
    expect(put).toHaveBeenCalledWith('/drafts/gmail-draft-1', { message: { raw: 'bmV4dA' } })
  })
})
