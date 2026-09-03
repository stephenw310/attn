// Minimal authorized Gmail REST client with token refresh and backoff.
// Plain Node module; token persistence is injected by the caller.

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { OAuthConfig, TokenSet } from '../auth/googleAuth'
import {
  DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE,
  GMAIL_MAX_RETRIES,
  GMAIL_RETRY_BASE_MS,
  GMAIL_RETRY_JITTER_MS,
  GMAIL_RETRY_MAX_MS,
  GMAIL_TOKEN_REFRESH_MARGIN_MS
} from '../sync/tuning'
import { type SchedulerTime, systemTime } from '../time'
import {
  GMAIL_QUOTA_UNITS,
  type GmailQuotaConfig,
  type GmailQuotaLimiter,
  type GmailQuotaMetrics,
  type GmailRequestPriority,
  quotaMethod,
  GmailQuotaLimiter as WeightedQuotaLimiter
} from './quota'

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

export class GmailAuthError extends Error {}

interface RequestOptions {
  params?: Record<string, string | string[]>
  body?: unknown
  retryTransient?: boolean
  signal?: AbortSignal
  priority?: GmailRequestPriority
}

export interface GmailClientOptions {
  time?: SchedulerTime
  random?: () => number
  quota?: GmailQuotaConfig
  quotaLimiter?: GmailQuotaLimiter
  /** Account removal cancels reads; draft mutations retain their shutdown grace period. */
  readSignal?: AbortSignal
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
  private readonly time: SchedulerTime
  private readonly random: () => number
  private readonly quotaLimiter: GmailQuotaLimiter
  private readonly readSignal: AbortSignal | undefined
  private refreshInFlight: Promise<string> | null = null

  constructor(
    private readonly config: OAuthConfig,
    private tokens: TokenSet,
    private readonly persist: (t: TokenSet) => void,
    options: GmailClientOptions = {}
  ) {
    this.time = options.time ?? systemTime
    this.random = options.random ?? Math.random
    this.readSignal = options.readSignal
    this.quotaLimiter =
      options.quotaLimiter ??
      new WeightedQuotaLimiter(options.quota ?? { unitsPerMinute: DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE }, {
        time: this.time
      })
  }

  quotaMetrics(): GmailQuotaMetrics {
    return this.quotaLimiter.snapshot()
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.time.now() < this.tokens.expires_at - GMAIL_TOKEN_REFRESH_MARGIN_MS)
      return this.tokens.access_token
    return this.refresh()
  }

  /**
   * Single-flight. Three backfill workers plus the poller, the hydrator and the
   * executor cross the expiry margin together; without this each would POST to
   * the token endpoint and `persist()` a token the others had already replaced.
   * The shared request follows the client's own read signal rather than any one
   * caller's, so a canceled search cannot fail the refresh everyone is awaiting.
   */
  private refresh(): Promise<string> {
    const started = this.refreshInFlight ?? this.runRefresh()
    if (this.refreshInFlight !== started) {
      this.refreshInFlight = started
      const clear = (): void => {
        if (this.refreshInFlight === started) this.refreshInFlight = null
      }
      // Also marks the shared promise handled: its rejection reaches every
      // caller through their own await, not as an unhandled rejection.
      void started.then(clear, clear)
    }
    return started
  }

  private async runRefresh(): Promise<string> {
    if (!this.tokens.refresh_token) {
      throw new GmailAuthError('no refresh token stored — sign in again')
    }
    let attempt = 0
    for (;;) {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.client_id,
          client_secret: this.config.client_secret,
          refresh_token: this.tokens.refresh_token,
          grant_type: 'refresh_token'
        }),
        signal: this.readSignal
      })
      if (!res.ok) {
        const message = `token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`
        if (res.status === 400 || res.status === 401) throw new GmailAuthError(message)
        const transient = res.status === 429 || res.status >= 500
        // A rate-limited or briefly unavailable token endpoint is the same
        // failure `request()` already rides out; without this it escaped that
        // loop and failed the call it was refreshing for.
        if (transient && attempt < GMAIL_MAX_RETRIES) {
          attempt++
          await sleep(
            Math.min(GMAIL_RETRY_MAX_MS, GMAIL_RETRY_BASE_MS * 2 ** attempt) +
              this.random() * GMAIL_RETRY_JITTER_MS,
            this.time,
            this.readSignal
          )
          continue
        }
        throw new GmailApiError(res.status, message, transient)
      }
      const json = (await res.json()) as { access_token: string; expires_in: number }
      // Google's refresh response carries NO refresh_token — merge over the
      // existing set so the stored refresh_token survives.
      this.tokens = {
        ...this.tokens,
        access_token: json.access_token,
        expires_at: this.time.now() + json.expires_in * 1000
      }
      this.persist(this.tokens)
      return this.tokens.access_token
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string | string[]>,
    options?: { signal?: AbortSignal; priority?: GmailRequestPriority }
  ): Promise<T> {
    const signal =
      this.readSignal && options?.signal
        ? AbortSignal.any([this.readSignal, options.signal])
        : (this.readSignal ?? options?.signal)
    signal?.throwIfAborted()
    const result = await this.request<T>('GET', path, {
      params,
      signal,
      priority: options?.priority
    })
    // Also fence a response whose body completed concurrently with removal.
    signal?.throwIfAborted()
    return result
  }

  async post<T>(
    path: string,
    body: unknown,
    options?: { retryTransient?: boolean; signal?: AbortSignal; priority?: GmailRequestPriority }
  ): Promise<T> {
    return this.request('POST', path, {
      body,
      retryTransient: options?.retryTransient,
      signal: options?.signal,
      priority: options?.priority
    })
  }

  async put<T>(
    path: string,
    body: unknown,
    options?: { retryTransient?: boolean; signal?: AbortSignal; priority?: GmailRequestPriority }
  ): Promise<T> {
    return this.request('PUT', path, {
      body,
      retryTransient: options?.retryTransient,
      signal: options?.signal,
      priority: options?.priority
    })
  }

  async multipartUpload<T>(
    method: 'POST' | 'PUT',
    path: string,
    metadata: unknown,
    media: MultipartMedia,
    options?: { signal?: AbortSignal; priority?: GmailRequestPriority }
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
      const token = await this.ensureAccessToken()
      await this.acquireQuota(method, path, options?.priority, options?.signal)
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
        await this.refresh()
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

  async delete(
    path: string,
    options?: { retryTransient?: boolean; signal?: AbortSignal; priority?: GmailRequestPriority }
  ): Promise<void> {
    await this.request('DELETE', path, {
      retryTransient: options?.retryTransient,
      signal: options?.signal,
      priority: options?.priority
    })
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
      const token = await this.ensureAccessToken()
      await this.acquireQuota(method, path, options.priority, options.signal)
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
        await this.refresh()
        continue
      }
      // Gmail reports some rate/quota limits as 403 rather than 429. The
      // weighted limiter handles normal pacing; backoff remains the fallback
      // for server-side contention and quota state this client cannot observe.
      const quotaHit = res.status === 403 && /quota|rate ?limit/i.test(text)
      if (
        options.retryTransient !== false &&
        (res.status === 429 || res.status >= 500 || quotaHit) &&
        attempt < GMAIL_MAX_RETRIES
      ) {
        attempt++
        await sleep(
          Math.min(GMAIL_RETRY_MAX_MS, GMAIL_RETRY_BASE_MS * 2 ** attempt) +
            this.random() * GMAIL_RETRY_JITTER_MS,
          this.time,
          options.signal
        )
        continue
      }
      throw new GmailApiError(
        res.status,
        `gmail ${path} failed (${res.status}): ${text.slice(0, 300)}`,
        res.status === 429 || res.status >= 500 || quotaHit
      )
    }
  }

  private acquireQuota(
    method: string,
    path: string,
    priority: GmailRequestPriority = 'foreground',
    signal?: AbortSignal
  ): Promise<void> {
    const quota = quotaMethod(method, path)
    return this.quotaLimiter.acquire(GMAIL_QUOTA_UNITS[quota], priority, signal)
  }
}

function sleep(ms: number, time: SchedulerTime, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))
  return new Promise((resolve, reject) => {
    const timer = time.timers.setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      time.timers.clearTimeout(timer)
      reject(signal?.reason ?? new Error('request aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
