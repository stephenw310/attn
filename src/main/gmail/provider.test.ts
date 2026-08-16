import { describe, expect, it, vi } from 'vitest'
import type { GmailClient } from './client'
import { GmailMailProvider } from './provider'

describe('GmailMailProvider.listThreadIds', () => {
  it('passes explicit labels without silently adding INBOX', async () => {
    const get = vi.fn(async () => ({ threads: [{ id: 'sent-1' }], resultSizeEstimate: 42 }))
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(
      provider.listThreadIds({ labelIds: ['SENT'], q: 'newer_than:12m', pageToken: 'next' })
    ).resolves.toEqual({
      threadIds: ['sent-1'],
      nextPageToken: undefined,
      resultSizeEstimate: 42
    })
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

  it('keeps a reply checkpoint attached to its Gmail thread', async () => {
    const post = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)

    await provider.saveDraft({ id: null, raw: 'cmF3', threadId: 'thread-1' })
    expect(post).toHaveBeenCalledWith('/drafts', {
      message: { raw: 'cmF3', threadId: 'thread-1' }
    })
  })

  it('deletes a mirrored Gmail draft without exposing a send endpoint', async () => {
    const deleteRequest = vi.fn(async () => {})
    const provider = new GmailMailProvider({ delete: deleteRequest } as unknown as GmailClient)

    await expect(provider.deleteDraft('gmail/draft 1')).resolves.toBeUndefined()
    expect(deleteRequest).toHaveBeenCalledWith('/drafts/gmail%2Fdraft%201')
  })
})

describe('GmailMailProvider inbound drafts', () => {
  it('lists draft ids and fetches a full draft by draft id', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        drafts: [{ id: 'r-1', message: { id: 'm-1', threadId: 't-1' } }],
        nextPageToken: 'next'
      })
      .mockResolvedValueOnce({ id: 'r-1', message: { id: 'm-1', threadId: 't-1' } })
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(provider.listDrafts()).resolves.toEqual({
      drafts: [{ id: 'r-1', messageId: 'm-1', threadId: 't-1' }],
      nextPageToken: 'next'
    })
    await provider.getDraft('r/1')
    expect(get).toHaveBeenNthCalledWith(1, '/drafts', { maxResults: '100' })
    expect(get).toHaveBeenNthCalledWith(2, '/drafts/r%2F1', { format: 'full' })
  })
})
