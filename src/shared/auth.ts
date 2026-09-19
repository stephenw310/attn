// Auth status contract shared by main, preload, and renderer.

import type { SyncState } from './mail'

/** One signed-in Google account. `id` is the normalized (lowercased) address. */
export interface AuthAccount {
  id: string
  email: string
}

/** One-word health readout per account for the account menu (F18). */
export type AccountSyncPhase = 'live' | 'syncing' | 'offline' | 'error' | 'reconnect'

export interface AccountSyncStatus {
  accountId: string
  phase: AccountSyncPhase
  /** Notification-enabled unread count (badge semantics), per account. */
  unread: number
}

export const ACCOUNT_SYNC_PHASE_LABELS: Record<AccountSyncPhase, string> = {
  live: 'Live',
  syncing: 'Syncing',
  offline: 'Offline',
  error: 'Error',
  reconnect: 'Reconnect'
}

/**
 * Collapse a sync session's state to the menu's one-word readout. An
 * auth-paused queue outranks everything — the account needs the user, and
 * every other word would hide that behind a switch (F18).
 */
export function accountSyncPhase(state: SyncState, authPaused: boolean): AccountSyncPhase {
  if (authPaused) return 'reconnect'
  if (state.phase === 'offline') return 'offline'
  if (state.phase === 'error') return 'error'
  if (state.phase === 'idle') return 'live'
  return 'syncing'
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

/**
 * Electron's `ipcRenderer.invoke` rejects with
 * `Error invoking remote method 'channel': Error: <message>`. Strip that
 * wrapper and the nested `Error:` prefixes it leaves behind, then rewrite the
 * OAuth outcomes a user can act on. Every surface that reports a failed
 * sign-in renders this, so the bridge text never reaches the UI.
 */
export function signInErrorMessage(reason: unknown, fallback: string): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  let message = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').trim()
  while (/^[A-Za-z]*Error:/.test(message)) message = message.replace(/^[A-Za-z]*Error:\s*/, '').trim()
  if (message.includes('access_denied')) {
    return 'Google did not grant access. Try again and allow the requested permissions.'
  }
  return message === '' ? fallback : message
}
