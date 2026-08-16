import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GmailApiError, GmailClient } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GmailClient transient retries', () => {
  it('does not replay a non-idempotent POST when transient retries are disabled', async () => {
    const fetchMock = vi.fn(async () => new Response('uncertain create', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient(
      { client_id: 'client', client_secret: 'secret' },
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Date.now() + 3_600_000
      },
      vi.fn()
    )

    await expect(
      client.post('/drafts', { message: { raw: 'cmF3' } }, { retryTransient: false })
    ).rejects.toEqual(expect.objectContaining<Partial<GmailApiError>>({ status: 503, retryable: true }))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancels an in-progress transient backoff when its signal is aborted', async () => {
    const fetchMock = vi.fn(async () => new Response('retry later', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient(
      { client_id: 'client', client_secret: 'secret' },
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Date.now() + 3_600_000
      },
      vi.fn()
    )
    const controller = new AbortController()

    const request = client.get('/profile', undefined, { signal: controller.signal })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort(new Error('shutdown'))

    await expect(request).rejects.toThrow('shutdown')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
