import { describe, expect, it, vi } from 'vitest'
import { GmailApiError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'
import { executeDraftSendProtocol, isRetryableOutboxPreflightError, verifyKnownDraft } from './sender'

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(),
    trashThread: vi.fn(),
    untrashThread: vi.fn(),
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    listThreadIds: vi.fn(),
    getThread: vi.fn(),
    getAttachmentData: vi.fn(),
    listHistory: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: 'thread-1' } })),
    saveDraft: vi.fn(async ({ id }) => id ?? 'created-draft'),
    createDraft: vi.fn(async () => 'created-draft'),
    updateDraft: vi.fn(async ({ id }) => id),
    sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: 'sent-thread' })),
    findByRfcId: vi.fn(),
    ...overrides
  }
}

describe('outbox Gmail draft protocol', () => {
  it('creates, persists, updates, then sends in that exact order', async () => {
    const order: string[] = []
    const fake = provider({
      createDraft: vi.fn(async () => {
        order.push('create')
        return 'created-draft'
      }),
      updateDraft: vi.fn(async ({ id }) => {
        order.push(`update:${id}`)
        return id
      }),
      sendDraft: vi.fn(async (id) => {
        order.push(`send:${id}`)
        return { id: 'sent-message', threadId: 'sent-thread' }
      })
    })

    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: 'thread-1',
        persistCreatedId: (id) => {
          order.push(`persist:${id}`)
          return true
        }
      })
    ).resolves.toEqual({ kind: 'sent', threadId: 'sent-thread' })
    expect(order).toEqual(['create', 'persist:created-draft', 'update:created-draft', 'send:created-draft'])
  })

  it('never updates or sends when a crash/error prevents id persistence', async () => {
    const createDraft = vi.fn(async () => 'orphaned-draft')
    const updateDraft = vi.fn(async ({ id }: { id: string }) => id)
    const sendDraft = vi.fn(async () => ({ id: 'sent', threadId: 'thread' }))
    const fake = provider({ createDraft, updateDraft, sendDraft })

    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => false
      })
    ).resolves.toEqual({ kind: 'aborted' })
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(updateDraft).not.toHaveBeenCalled()
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('distinguishes a definitive retryable create rejection from an ambiguous create failure', async () => {
    const rejected = provider({
      createDraft: vi.fn(async () => {
        throw new GmailApiError(429, 'quota', true)
      })
    })
    await expect(
      executeDraftSendProtocol(rejected, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toMatchObject({
      reason: expect.objectContaining({ status: 429, retryable: true })
    })

    const ambiguous = new TypeError('fetch failed')
    const uncertain = provider({
      createDraft: vi.fn(async () => {
        throw ambiguous
      })
    })
    await expect(
      executeDraftSendProtocol(uncertain, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toBe(ambiguous)

    const timedOut = new GmailApiError(408, 'deadline exceeded', true)
    const timeout = provider({
      createDraft: vi.fn(async () => {
        throw timedOut
      })
    })
    await expect(
      executeDraftSendProtocol(timeout, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toBe(timedOut)
  })

  it('treats send 404 as an already-consumed draft, never a blind-resend signal', async () => {
    const fake = provider({
      sendDraft: vi.fn(async () => {
        throw new GmailApiError(404, 'gone')
      })
    })
    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: 'known-draft',
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).resolves.toEqual({ kind: 'consumed' })
  })

  it('does not call send or claim success when the draft is missing during update', async () => {
    const sendDraft = vi.fn(async () => ({ id: 'sent', threadId: 'thread' }))
    const fake = provider({
      updateDraft: vi.fn(async () => {
        throw new GmailApiError(404, 'deleted before send')
      }),
      sendDraft
    })
    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: 'missing-draft',
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).resolves.toEqual({ kind: 'missing-before-send' })
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('uses draft presence as the decisive recovery probe', async () => {
    await expect(verifyKnownDraft(provider(), 'present')).resolves.toBe('present')
    await expect(
      verifyKnownDraft(
        provider({
          getDraft: vi.fn(async () => {
            throw new GmailApiError(404, 'consumed')
          })
        }),
        'consumed'
      )
    ).resolves.toBe('consumed')
  })
})

describe('outbox preflight failures', () => {
  it('retries only errors that can recover without editing the message', () => {
    expect(isRetryableOutboxPreflightError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableOutboxPreflightError(new GmailApiError(503, 'unavailable', true))).toBe(true)
    expect(isRetryableOutboxPreflightError(new Error('local attachment unavailable'))).toBe(false)
  })
})
