// Auth status contract shared by main, preload, and renderer.

/** One signed-in Google account. `id` is the normalized (lowercased) address. */
export interface AuthAccount {
  id: string
  email: string
}

export interface AuthStatus {
  /** oauth.config.json found and has a client_id */
  configured: boolean
  /** at least one account is signed in */
  signedIn: boolean
  /** the active account's address (F18: the one the UI renders) */
  email?: string
  /** every signed-in account in switcher order (`Mod+1..9` follows this) */
  accounts: AuthAccount[]
  activeAccountId: string | null
}

export interface AuthSignInResult {
  status: AuthStatus
  resumedActions: number
  /**
   * The account the completed OAuth flow identified (normalized). Sign-in no
   * longer activates a newly added account by itself — activation goes through
   * the guarded switch — so this tells the renderer what to offer switching to.
   * Absent when the flow ended without tokens (e.g. unconfigured OAuth).
   */
  accountId?: string
}

/**
 * A sign-in the user abandoned, or one superseded by a second click. Every
 * surface that starts a sign-in stays silent about it — it is not an error.
 */
export function isSignInCanceled(reason: unknown): boolean {
  return (reason instanceof Error ? reason.message : String(reason)).includes('sign-in canceled')
}
