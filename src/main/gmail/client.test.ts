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

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('GmailClient multipart uploads', () => {
  it('streams metadata and RFC message bytes to the Gmail upload endpoint', async () => {
    let requestBody = ''
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) throw new Error('missing upload body')
      const chunks: Buffer[] = []
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk))
      }
      requestBody = Buffer.concat(chunks).toString()
      return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 })
    })
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
    const open = vi.fn(async function* () {
      yield Buffer.from('From: me@example.com\r\n')
      yield Buffer.from('\r\nBody\r\n')
    })

    await expect(
      client.multipartUpload(
        'PUT',
        '/drafts/draft-1',
        { id: 'draft-1' },
        {
          mimeType: 'message/rfc822',
          sizeBytes: Buffer.byteLength('From: me@example.com\r\n\r\nBody\r\n'),
          endsWithCrlf: true,
          open
        }
      )
    ).resolves.toEqual({ id: 'draft-1' })

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/draft-1?uploadType=multipart'
    )
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['Content-Type']).toMatch(/^multipart\/related; boundary=attn-upload-/)
    expect(Number(headers['Content-Length'])).toBe(Buffer.byteLength(requestBody))
    expect(requestBody).toContain('Content-Type: application/json; charset=UTF-8')
    expect(requestBody).toContain('{"id":"draft-1"}')
    expect(requestBody).toContain('Content-Type: message/rfc822\r\n\r\nFrom: me@example.com')
    expect(requestBody).toMatch(/--attn-upload-[^\r]+--\r\n$/)
    expect(open).toHaveBeenCalledOnce()
  })

  it('reopens a sized media stream after refreshing an expired access token', async () => {
    const requestBodies: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 })
      }
      if (!init?.body) throw new Error('missing upload body')
      const chunks: Buffer[] = []
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk))
      }
      requestBodies.push(Buffer.concat(chunks).toString())
      return requestBodies.length === 1
        ? new Response('expired', { status: 401 })
        : new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient(
      { client_id: 'client', client_secret: 'secret' },
      {
        access_token: 'expired',
        refresh_token: 'refresh',
        expires_at: Date.now() + 3_600_000
      },
      vi.fn()
    )
    const content = Buffer.from('Raw message\r\n')
    const open = vi.fn(async function* () {
      yield content
    })

    await expect(
      client.multipartUpload(
        'PUT',
        '/drafts/draft-1',
        { message: {} },
        { mimeType: 'message/rfc822', sizeBytes: content.byteLength, endsWithCrlf: true, open }
      )
    ).resolves.toEqual({ id: 'draft-1' })

    expect(open).toHaveBeenCalledTimes(2)
    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[1]).toBe(requestBodies[0])
  })
})
