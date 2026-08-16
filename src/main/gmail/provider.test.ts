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
  it('creates a Gmail draft for checkpointing or the outbox sender', async () => {
    const post = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)

    await expect(provider.saveDraft({ id: null, raw: 'cmF3' })).resolves.toBe('gmail-draft-1')
    expect(post).toHaveBeenCalledWith(
      '/drafts',
      { message: { raw: 'cmF3' } },
      { retryTransient: false, signal: undefined }
    )
  })

  it('updates the known Gmail draft id', async () => {
    const put = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ put } as unknown as GmailClient)

    await expect(provider.saveDraft({ id: 'gmail-draft-1', raw: 'bmV4dA' })).resolves.toBe('gmail-draft-1')
    expect(put).toHaveBeenCalledWith(
      '/drafts/gmail-draft-1',
      { message: { raw: 'bmV4dA' } },
      { retryTransient: false, signal: undefined }
    )
  })

  it('keeps a reply checkpoint attached to its Gmail thread', async () => {
    const post = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)

    await provider.saveDraft({ id: null, raw: 'cmF3', threadId: 'thread-1' })
    expect(post).toHaveBeenCalledWith(
      '/drafts',
      { message: { raw: 'cmF3', threadId: 'thread-1' } },
      { retryTransient: false, signal: undefined }
    )
  })

  it('deletes a mirrored Gmail draft', async () => {
    const deleteRequest = vi.fn(async () => {})
    const provider = new GmailMailProvider({ delete: deleteRequest } as unknown as GmailClient)

    await expect(provider.deleteDraft('gmail/draft 1')).resolves.toBeUndefined()
    expect(deleteRequest).toHaveBeenCalledWith('/drafts/gmail%2Fdraft%201', {
      retryTransient: false,
      signal: undefined
    })
  })
})

describe('GmailMailProvider.saveDraft', () => {
  it('propagates shutdown cancellation to a single checkpoint request', async () => {
    const post = vi.fn(async () => ({ id: 'gmail-draft-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)
    const controller = new AbortController()

    await provider.saveDraft({ id: null, raw: 'cmF3' }, { signal: controller.signal })

    expect(post).toHaveBeenCalledWith(
      '/drafts',
      { message: { raw: 'cmF3' } },
      { retryTransient: false, signal: controller.signal }
    )
  })
})

describe('GmailMailProvider.getAttachmentData', () => {
  it('propagates shutdown cancellation to attachment hydration', async () => {
    const get = vi.fn(async () => ({ data: 'cmVtb3Rl' }))
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)
    const controller = new AbortController()

    await expect(
      provider.getAttachmentData('message/1', 'attachment/1', { signal: controller.signal })
    ).resolves.toBe('cmVtb3Rl')
    expect(get).toHaveBeenCalledWith('/messages/message%2F1/attachments/attachment%2F1', undefined, {
      signal: controller.signal
    })
  })
})

describe('GmailMailProvider outbox operations', () => {
  it('creates once without the generic transient retry loop, then updates by durable id', async () => {
    const post = vi.fn(async () => ({ id: 'draft-1' }))
    const put = vi.fn(async () => ({ id: 'draft-1' }))
    const provider = new GmailMailProvider({ post, put } as unknown as GmailClient)

    await expect(provider.createDraft({ raw: 'cmF3', threadId: 'thread-1' })).resolves.toBe('draft-1')
    expect(post).toHaveBeenCalledWith(
      '/drafts',
      { message: { raw: 'cmF3', threadId: 'thread-1' } },
      { retryTransient: false, signal: undefined }
    )
    await expect(provider.updateDraft({ id: 'draft-1', raw: 'bmV4dA' })).resolves.toBe('draft-1')
    expect(put).toHaveBeenCalledWith(
      '/drafts/draft-1',
      { message: { raw: 'bmV4dA' } },
      {
        retryTransient: false,
        signal: undefined
      }
    )
  })

  it('updates an attachment-bearing draft through one multipart media upload', async () => {
    const multipartUpload = vi.fn(async () => ({ id: 'draft-1' }))
    const provider = new GmailMailProvider({ multipartUpload } as unknown as GmailClient)
    const open = async function* (): AsyncIterable<Uint8Array> {
      yield Buffer.from('raw mime')
    }

    await expect(
      provider.updateDraft({ id: 'draft-1', mime: { sizeBytes: 8, open }, threadId: 'thread-1' })
    ).resolves.toBe('draft-1')
    expect(multipartUpload).toHaveBeenCalledWith(
      'PUT',
      '/drafts/draft-1',
      { message: { threadId: 'thread-1' } },
      { mimeType: 'message/rfc822', sizeBytes: 8, endsWithCrlf: true, open },
      { signal: undefined }
    )
  })

  it('sends only a known durable Gmail draft id', async () => {
    const post = vi.fn(async () => ({ id: 'message-1', threadId: 'thread-1' }))
    const provider = new GmailMailProvider({ post } as unknown as GmailClient)

    await expect(provider.sendDraft('draft/1')).resolves.toEqual({
      id: 'message-1',
      threadId: 'thread-1'
    })
    expect(post).toHaveBeenCalledWith(
      '/drafts/send',
      { id: 'draft/1' },
      {
        retryTransient: false,
        signal: undefined
      }
    )
  })

  it('finds an orphaned draft even when the draft-scoped search omits it', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [{ id: 'draft-message', threadId: 'thread-1' }] })
      .mockResolvedValueOnce({ id: 'draft-message', threadId: 'thread-1', labelIds: ['DRAFT'] })
      .mockResolvedValueOnce({
        drafts: [{ id: 'draft-1', message: { id: 'draft-message', threadId: 'thread-1' } }]
      })
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(provider.findByRfcId('<stable@attn.local>')).resolves.toEqual({
      kind: 'draft',
      draftId: 'draft-1',
      messageId: 'draft-message',
      threadId: 'thread-1'
    })
    expect(get).toHaveBeenNthCalledWith(
      1,
      '/messages',
      {
        q: 'in:drafts rfc822msgid:stable@attn.local',
        maxResults: '10',
        includeSpamTrash: 'true'
      },
      undefined
    )
  })

  it('finds an accepted non-draft message and returns null on bounded negatives', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [{ id: 'sent-message', threadId: 'thread-2' }] })
      .mockResolvedValueOnce({ id: 'sent-message', threadId: 'thread-2', labelIds: ['SENT'] })
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [] })
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(provider.findByRfcId('<sent@attn.local>')).resolves.toEqual({
      kind: 'message',
      messageId: 'sent-message',
      threadId: 'thread-2'
    })
    expect(get.mock.calls.some(([path]) => path === '/drafts')).toBe(false)
    await expect(provider.findByRfcId('<missing@attn.local>')).resolves.toBeNull()
  })

  it('never promotes an unverified draft search hit to a sent message', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [{ id: 'draft-message', threadId: 'thread-1' }] })
      .mockResolvedValueOnce({ id: 'draft-message', threadId: 'thread-1', labelIds: ['DRAFT'] })
      .mockResolvedValueOnce({ drafts: [] })
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(provider.findByRfcId('<still-draft@example.com>')).resolves.toBeNull()
    expect(get).toHaveBeenNthCalledWith(3, '/messages/draft-message', { format: 'minimal' }, undefined)
    expect(get).toHaveBeenLastCalledWith('/drafts', { maxResults: '100' }, undefined)
  })

  it('does not page the full drafts list twice for an already-checked candidate', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ id: 'draft-message', threadId: 'thread-1' }] })
      .mockResolvedValueOnce({ messages: [{ id: 'draft-message', threadId: 'thread-1' }] })
      .mockResolvedValueOnce({ drafts: [] })
      .mockResolvedValueOnce({ id: 'draft-message', threadId: 'thread-1', labelIds: ['DRAFT'] })
    const provider = new GmailMailProvider({ get } as unknown as GmailClient)

    await expect(provider.findByRfcId('<missing-draft@example.com>')).resolves.toBeNull()
    expect(get.mock.calls.filter(([path]) => path === '/drafts')).toHaveLength(1)
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
    expect(get).toHaveBeenNthCalledWith(1, '/drafts', { maxResults: '100' }, undefined)
    expect(get).toHaveBeenNthCalledWith(2, '/drafts/r%2F1', { format: 'full' }, undefined)
  })
})
