// Pure multi-account token-file format (F18): parsing, the one-time fold-in of
// the legacy single-account file, and roster edits. Electron-free so the format
// is unit-testable; tokenStore.ts owns safeStorage and disk IO.

import { normalizeEmailKey } from '../../shared/address'
import type { TokenSet } from './googleAuth'

export interface StoredAccount {
  /** Normalized email — the account id used across the store and the roster. */
  id: string
  tokens: TokenSet
}

export interface TokenFile {
  version: 2
  /** Ordered: index is the switcher position (`Mod+1..9`). */
  accounts: StoredAccount[]
}

export function accountIdForTokens(tokens: TokenSet): string | null {
  const email = tokens.email?.trim()
  return email ? normalizeEmailKey(email) : null
}

function isTokenSet(value: unknown): value is TokenSet {
  if (!value || typeof value !== 'object') return false
  const tokens = value as Partial<TokenSet>
  return typeof tokens.access_token === 'string' && typeof tokens.expires_at === 'number'
}

/**
 * Parse a decrypted token file. Accepts the v2 roster or the legacy single
 * `TokenSet` shape, which folds into a one-account roster keyed by its email; a
 * legacy set without an email was never usable as an account and is dropped.
 * Returns null when the payload is neither, so a corrupt file reads as
 * signed-out rather than crashing sign-in.
 */
export function parseTokenFile(value: unknown): TokenFile | null {
  if (!value || typeof value !== 'object') return null
  const file = value as Partial<TokenFile>
  if (file.version === 2 && Array.isArray(file.accounts)) {
    const seen = new Set<string>()
    const accounts: StoredAccount[] = []
    for (const entry of file.accounts) {
      if (!entry || typeof entry !== 'object') continue
      const { id, tokens } = entry as Partial<StoredAccount>
      if (typeof id !== 'string' || id.length === 0 || !isTokenSet(tokens) || seen.has(id)) continue
      seen.add(id)
      accounts.push({ id, tokens })
    }
    return { version: 2, accounts }
  }
  if (isTokenSet(value)) {
    const id = accountIdForTokens(value)
    return { version: 2, accounts: id ? [{ id, tokens: value }] : [] }
  }
  return null
}

/** Was this parsed payload the legacy single-account shape (needs a rewrite)? */
export function isLegacyTokenPayload(value: unknown): boolean {
  return isTokenSet(value)
}

/** Add a new account at the end, or refresh an existing one in place. */
export function upsertAccount(accounts: readonly StoredAccount[], tokens: TokenSet): StoredAccount[] {
  const id = accountIdForTokens(tokens)
  if (!id) throw new Error('Google did not return an email address for this account')
  const existing = accounts.findIndex((account) => account.id === id)
  if (existing === -1) return [...accounts, { id, tokens }]
  return accounts.map((account, index) => (index === existing ? { id, tokens } : account))
}

export function removeAccount(accounts: readonly StoredAccount[], id: string): StoredAccount[] {
  return accounts.filter((account) => account.id !== id)
}

/**
 * Validate that `ids` is an exact permutation of `currentIds` (F15/F18: the
 * switcher order behind `Mod+1..9`). Duplicates, unknown ids, and a wrong
 * length all reject — a stale request from before a roster change must not
 * silently drop or resurrect an account.
 */
export function reorderIds(currentIds: readonly string[], ids: readonly string[]): string[] {
  if (ids.length !== currentIds.length) throw new Error('stale account order')
  const known = new Set(currentIds)
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error('duplicate account in order')
    seen.add(id)
    if (!known.has(id)) throw new Error('unknown account in order')
  }
  return [...ids]
}

/**
 * Reorder the roster to an exact permutation of itself. Token sets are
 * carried from the current roster, so a refresh that raced the reorder keeps
 * its newest tokens.
 */
export function reorderRoster(accounts: readonly StoredAccount[], ids: readonly string[]): StoredAccount[] {
  const ordered = reorderIds(
    accounts.map((account) => account.id),
    ids
  )
  const byId = new Map(accounts.map((account) => [account.id, account]))
  return ordered.map((id) => byId.get(id) as StoredAccount)
}
