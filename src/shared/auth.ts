// Auth status contract shared by main, preload, and renderer.

export interface AuthStatus {
  /** oauth.config.json found and has a client_id */
  configured: boolean
  /** stored tokens exist */
  signedIn: boolean
  email?: string
}
