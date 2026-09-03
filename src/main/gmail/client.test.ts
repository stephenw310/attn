import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchedulerTime, TimerHandle } from '../time'
import { GmailApiError, GmailAuthError, GmailClient, type GmailClientOptions } from './client'

/** Runs every scheduled backoff at once, so retry budgets cost no wall-clock time. */
const immediateTime: SchedulerTime = {
  now: () => Date.now(),
  timers: {
    setTimeout: (callback: () => void): TimerHandle => {
      callback()
      return 0 as unknown as TimerHandle
    },
    clearTimeout: () => {}
  }
}

function expiredClient(refreshToken?: string, options: GmailClientOptions = {}): GmailClient {
  return new GmailClient(
    { client_id: 'client', client_secret: 'secret' },
    {
      access_token: 'expired',
      refresh_token: refreshToken,
      expires_at: 0,
      email: 'a@example.com'
    },
    vi.fn(),
    options
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account read cancellation', () => {
  it('rejects late reads and new reads, but preserves a returned mutation id', async () => {
    const readAbort = new AbortController()
    let releaseRead!: (response: Response) => void
    let releaseCreate!: (response: Response) => void
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          if (init?.method === 'POST') releaseCreate = resolve
          else releaseRead = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient(
      { client_id: 'client', client_secret: 'secret' },
      { access_token: 'access', expires_at: Date.now() + 3_600_000 },
      vi.fn(),
      { readSignal: readAbort.signal }
    )
    const read = client.get('/threads/t1')
    const create = client.post('/drafts', {}, { retryTransient: false })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const rejected = expect(read).rejects.toThrow('account removed')
    readAbort.abort(new Error('account removed'))
    // Model a transport whose already-buffered response still resolves.
    releaseRead(new Response(JSON.stringify({ id: 't1' })))
    releaseCreate(new Response(JSON.stringify({ id: 'remote-draft' })))
    await rejected
    await expect(create).resolves.toEqual({ id: 'remote-draft' })
    await expect(client.get('/profile')).rejects.toThrow('account removed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
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

    const unavailable = vi.fn(async () => new Response('temporarily unavailable', { status: 503 }))
    vi.stubGlobal('fetch', unavailable)
    const failure = await expiredClient('valid', { time: immediateTime, random: () => 0 })
      .get('/threads/t1')
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GmailApiError)
    expect(failure).toMatchObject({ status: 503, retryable: true })
    // The refresh rides out the same transient failure `request()` does instead
    // of escaping its retry loop on the first 503.
    expect(unavailable.mock.calls.length).toBeGreaterThan(1)
  })

  it('refreshes once for every caller that crosses the expiry margin together', async () => {
    let release!: (response: Response) => void
    const tokenPost = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return tokenPost()
      return Promise.resolve(new Response(JSON.stringify({ id: 't1' })))
    })
    vi.stubGlobal('fetch', fetchMock)
    const persist = vi.fn()
    const client = new GmailClient(
      { client_id: 'client', client_secret: 'secret' },
      { access_token: 'expired', refresh_token: 'refresh', expires_at: 0, email: 'a@example.com' },
      persist
    )

    const reads = [client.get('/threads/t1'), client.get('/threads/t2'), client.get('/messages/m1')]
    await vi.waitFor(() => expect(tokenPost).toHaveBeenCalled())
    release(new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 })))

    await expect(Promise.all(reads)).resolves.toEqual([{ id: 't1' }, { id: 't1' }, { id: 't1' }])
    expect(tokenPost).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
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
