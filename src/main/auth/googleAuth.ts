// Google OAuth 2.0 for installed apps: authorization-code + PKCE with a
// loopback redirect (SPEC F1). Plain Node module — the caller supplies
// openUrl so this file stays free of Electron imports.

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
// gmail.modify covers read, label changes, and send (SPEC F1).
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify openid email'
const FLOW_TIMEOUT_MS = 5 * 60 * 1000

export interface OAuthConfig {
  client_id: string
  client_secret: string
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_at: number
  email?: string
  // TODO(M0-final): refresh flow — untestable until a real client exists.
}

let activeCancel: (() => void) | null = null

/** Abort a pending sign-in (stale browser tab, user retrying). */
export function cancelActiveSignIn(): void {
  activeCancel?.()
  activeCancel = null
}

export function loadOAuthConfig(searchDirs: string[]): OAuthConfig | null {
  for (const dir of searchDirs) {
    try {
      const raw = readFileSync(join(dir, 'oauth.config.json'), 'utf8')
      const parsed = JSON.parse(raw) as Partial<OAuthConfig>
      if (parsed.client_id && parsed.client_secret) {
        return { client_id: parsed.client_id, client_secret: parsed.client_secret }
      }
    } catch {
      // missing or malformed in this dir — keep looking
    }
  }
  return null
}

export async function signInWithGoogle(
  config: OAuthConfig,
  openUrl: (url: string) => void
): Promise<TokenSet> {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  const { code, redirectUri } = await waitForAuthCode(config, challenge, state, openUrl)

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  })
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    id_token?: string
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
    email: json.id_token ? emailFromIdToken(json.id_token) : undefined
  }
}

function waitForAuthCode(
  config: OAuthConfig,
  challenge: string,
  state: string,
  openUrl: (url: string) => void
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    // Captured at listen time — server.address() returns null after close().
    let redirectUri = ''
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('sign-in timed out — no response from the browser within 5 minutes'))
    }, FLOW_TIMEOUT_MS)
    activeCancel = () => {
      clearTimeout(timeout)
      server.close()
      reject(new Error('sign-in canceled'))
    }

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const gotState = url.searchParams.get('state')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:sans-serif;background:#16181d;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh"><p>' +
          (err || gotState !== state || !code
            ? 'Sign-in failed — you can close this tab and retry from Attn.'
            : 'Signed in — you can close this tab and return to Attn.') +
          '</p></body></html>'
      )

      clearTimeout(timeout)
      server.close()
      activeCancel = null
      if (err) return reject(new Error(`Google returned error: ${err}`))
      if (gotState !== state) return reject(new Error('state mismatch in OAuth callback'))
      if (!code) return reject(new Error('no authorization code in OAuth callback'))
      resolve({ code, redirectUri })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      redirectUri = `http://127.0.0.1:${port}/callback`
      const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      })
      openUrl(`${AUTH_ENDPOINT}?${params.toString()}`)
    })
  })
}

function emailFromIdToken(idToken: string): string | undefined {
  // Display-only decode of the JWT payload; Google delivered it to us over
  // TLS in direct exchange, so signature verification is not required here.
  try {
    const payload = idToken.split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string
    }
    return json.email
  } catch {
    return undefined
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}
