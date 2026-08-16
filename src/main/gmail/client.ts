// Minimal authorized Gmail REST client with token refresh and backoff.
// Plain Node module; token persistence is injected by the caller.

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { OAuthConfig, TokenSet } from '../auth/googleAuth'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const UPLOAD_BASE = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

interface RequestOptions {
  params?: Record<string, string | string[]>
  body?: unknown
  retryTransient?: boolean
  signal?: AbortSignal
}

interface MultipartMedia {
  mimeType: string
  sizeBytes: number
  endsWithCrlf?: boolean
  open: () => AsyncIterable<Uint8Array>
}

async function* multipartUploadBody(
  prefix: Uint8Array,
  suffix: Uint8Array,
  media: MultipartMedia
): AsyncIterable<Uint8Array> {
  yield prefix
  yield* media.open()
  yield suffix
}

export class GmailClient {
  constructor(
    private readonly config: OAuthConfig,
    private tokens: TokenSet,
    private readonly persist: (t: TokenSet) => void
  ) {}

  private async ensureAccessToken(signal?: AbortSignal): Promise<string> {
    if (Date.now() < this.tokens.expires_at - 60_000) return this.tokens.access_token
    return this.refresh(signal)
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    if (!this.tokens.refresh_token) {
      throw new Error('no refresh token stored — sign in again')
    }
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        refresh_token: this.tokens.refresh_token,
        grant_type: 'refresh_token'
      }),
      signal
    })
    if (!res.ok) {
      throw new Error(`token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    const json = (await res.json()) as { access_token: string; expires_in: number }
    // Google's refresh response carries NO refresh_token — merge over the
    // existing set so the stored refresh_token survives.
    this.tokens = {
      ...this.tokens,
      access_token: json.access_token,
      expires_at: Date.now() + json.expires_in * 1000
    }
    this.persist(this.tokens)
    return this.tokens.access_token
  }

  async get<T>(
    path: string,
    params?: Record<string, string | string[]>,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    return this.request('GET', path, { params, signal: options?.signal })
  }

  async post<T>(
    path: string,
    body: unknown,
    options?: { retryTransient?: boolean; signal?: AbortSignal }
  ): Promise<T> {
    return this.request('POST', path, {
      body,
      retryTransient: options?.retryTransient,
      signal: options?.signal
    })
  }

  async put<T>(
    path: string,
    body: unknown,
    options?: { retryTransient?: boolean; signal?: AbortSignal }
  ): Promise<T> {
    return this.request('PUT', path, {
      body,
      retryTransient: options?.retryTransient,
      signal: options?.signal
    })
  }

  async multipartUpload<T>(
    method: 'POST' | 'PUT',
    path: string,
    metadata: unknown,
    media: MultipartMedia,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    const url = new URL(UPLOAD_BASE + path)
    url.searchParams.set('uploadType', 'multipart')
    const boundary = `attn-upload-${randomUUID()}`
    if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 0) {
      throw new Error('multipart media size is invalid')
    }
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}` +
        `\r\n--${boundary}\r\nContent-Type: ${media.mimeType}\r\n\r\n`
    )
    const suffix = Buffer.from(`${media.endsWithCrlf ? '' : '\r\n'}--${boundary}--\r\n`)
    const contentLength = prefix.byteLength + media.sizeBytes + suffix.byteLength
    let attempt = 0
    for (;;) {
      const token = await this.ensureAccessToken(options?.signal)
      const init = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(contentLength)
        },
        body: Readable.from(multipartUploadBody(prefix, suffix, media)) as unknown as BodyInit,
        signal: options?.signal,
        duplex: 'half' as const
      } satisfies RequestInit & { duplex: 'half' }
      const res = await fetch(url, init)
      if (res.ok) {
        const text = await res.text()
        return (text ? JSON.parse(text) : undefined) as T
      }
      const text = await res.text()
      if (res.status === 401 && attempt === 0) {
        attempt++
        await this.refresh(options?.signal)
        continue
      }
      const quotaHit = res.status === 403 && /quota|rate ?limit/i.test(text)
      throw new GmailApiError(
        res.status,
        `gmail ${path} upload failed (${res.status}): ${text.slice(0, 300)}`,
        res.status === 429 || res.status >= 500 || quotaHit
      )
    }
  }

  async delete(path: string, options: Pick<RequestOptions, 'signal'> = {}): Promise<void> {
    await this.request('DELETE', path, options)
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: RequestOptions
  ): Promise<T> {
    const url = new URL(BASE + path)
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (Array.isArray(v)) {
          for (const x of v) url.searchParams.append(k, x)
        } else {
          url.searchParams.set(k, v)
        }
      }
    }
    let attempt = 0
    for (;;) {
      const token = await this.ensureAccessToken(options.signal)
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
      })
      if (res.ok) {
        const text = await res.text()
        return (text ? JSON.parse(text) : undefined) as T
      }
      const text = await res.text()
      if (res.status === 401 && attempt === 0) {
        attempt++
        await this.refresh(options.signal)
        continue
      }
      // Gmail reports per-user rate/quota limits as 403, not 429. Per-MINUTE
      // quota windows need long backoff — wait into the next window. A proper
      // token-bucket limiter is deferred M2 hardening (docs/M2-PLAN.md).
      const quotaHit = res.status === 403 && /quota|rate ?limit/i.test(text)
      if (
        options.retryTransient !== false &&
        (res.status === 429 || res.status >= 500 || quotaHit) &&
        attempt < 7
      ) {
        attempt++
        await sleep(Math.min(65_000, 1000 * 2 ** attempt) + Math.random() * 1000, options.signal)
        continue
      }
      throw new GmailApiError(
        res.status,
        `gmail ${path} failed (${res.status}): ${text.slice(0, 300)}`,
        res.status === 429 || res.status >= 500 || quotaHit
      )
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('request aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
