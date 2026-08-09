// Minimal authorized Gmail REST client with token refresh and backoff.
// Plain Node module; token persistence is injected by the caller.

import type { OAuthConfig, TokenSet } from '../auth/googleAuth'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

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
      if (res.status === 401 && attempt === 0) {
        attempt++
        await this.refresh()
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        attempt++
        await sleep(400 * 2 ** attempt)
        continue
      }
      throw new Error(`gmail ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
