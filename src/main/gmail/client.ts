// Minimal authorized Gmail REST client with token refresh and backoff.
// Plain Node module; token persistence is injected by the caller.

import type { OAuthConfig, TokenSet } from '../auth/googleAuth'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class GmailClient {
  constructor(
    private readonly config: OAuthConfig,
    private tokens: TokenSet,
    private readonly persist: (t: TokenSet) => void
  ) {}

  private async ensureAccessToken(): Promise<string> {
    if (Date.now() < this.tokens.expires_at - 60_000) return this.tokens.access_token
    return this.refresh()
  }

  private async refresh(): Promise<string> {
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
      })
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

  async get<T>(path: string, params?: Record<string, string | string[]>): Promise<T> {
    const url = new URL(BASE + path)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x))
        else url.searchParams.set(k, v)
      }
    }
    let attempt = 0
    for (;;) {
      const token = await this.ensureAccessToken()
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) return (await res.json()) as T
      const text = await res.text()
      if (res.status === 401 && attempt === 0) {
        attempt++
        await this.refresh()
        continue
      }
      // Gmail reports per-user rate/quota limits as 403, not 429. Per-MINUTE
      // quota windows need long backoff — wait into the next window.
      // TODO(M1): replace with a token-bucket limiter in the sync process.
      const quotaHit = res.status === 403 && /quota|rate ?limit/i.test(text)
      if ((res.status === 429 || res.status >= 500 || quotaHit) && attempt < 7) {
        attempt++
        await sleep(Math.min(65_000, 1000 * 2 ** attempt) + Math.random() * 1000)
        continue
      }
      throw new GmailApiError(res.status, `gmail ${path} failed (${res.status}): ${text.slice(0, 300)}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
