// Auth status contract shared by main, preload, and renderer.

export interface AuthStatus {
  /** oauth.config.json found and has a client_id */
  configured: boolean
  /** stored tokens exist */
  signedIn: boolean
  email?: string
}

export interface AuthSignInResult {
  status: AuthStatus
  resumedActions: number
}

/**
 * A sign-in the user abandoned, or one superseded by a second click. Every
 * surface that starts a sign-in stays silent about it — it is not an error.
 */
export function isSignInCanceled(reason: unknown): boolean {
  return (reason instanceof Error ? reason.message : String(reason)).includes('sign-in canceled')
}
