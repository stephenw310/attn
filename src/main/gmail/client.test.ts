import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailApiError, GmailAuthError, GmailClient } from './client'

function expiredClient(refreshToken?: string): GmailClient {
  return new GmailClient(
    { client_id: 'client', client_secret: 'secret' },
    {
      access_token: 'expired',
      refresh_token: refreshToken,
      expires_at: 0,
      email: 'a@example.com'
    },
    vi.fn()
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('Gmail token refresh failures', () => {
  it('types a missing refresh token as an authentication failure', async () => {
    await expect(expiredClient().get('/threads/t1')).rejects.toBeInstanceOf(GmailAuthError)
  })

  it('types invalid_grant as authentication while leaving server failures retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }))
    )
    await expect(expiredClient('revoked').get('/threads/t1')).rejects.toBeInstanceOf(GmailAuthError)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
    )
    const failure = await expiredClient('valid')
      .get('/threads/t1')
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GmailApiError)
    expect(failure).toMatchObject({ status: 503, retryable: true })
  })
})
