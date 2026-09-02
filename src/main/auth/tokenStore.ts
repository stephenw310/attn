// Encrypted token persistence via Electron safeStorage
// (macOS Keychain-backed / Windows DPAPI — SPEC F1, §6 Security).
//
// The file holds the multi-account roster (tokenFile.ts). A legacy
// single-account tokens.bin is folded into the roster on first read and the
// file is rewritten once, so the old shape disappears from disk.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { TokenSet } from './googleAuth'
import {
  isLegacyTokenPayload,
  parseTokenFile,
  removeAccount,
  reorderRoster,
  type StoredAccount,
  upsertAccount
} from './tokenFile'

const FILE = 'tokens.bin'

function write(userDataDir: string, accounts: StoredAccount[]): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption unavailable; refusing to store tokens in plaintext')
  }
  writeFileSync(join(userDataDir, FILE), safeStorage.encryptString(JSON.stringify({ version: 2, accounts })))
}

/** The signed-in roster in switcher order. Missing or corrupt file → empty. */
export function loadAccounts(userDataDir: string): StoredAccount[] {
  const path = join(userDataDir, FILE)
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(safeStorage.decryptString(readFileSync(path)))
  } catch {
    return []
  }
  const file = parseTokenFile(parsed)
  if (!file) return []
  if (isLegacyTokenPayload(parsed)) {
    if (file.accounts.length === 0) {
      console.warn('[auth] dropped a legacy token set without an email address')
    }
    try {
      write(userDataDir, file.accounts)
    } catch (error) {
      // The fold-in retries on the next read; the parsed roster is still valid.
      console.warn(`[auth] could not rewrite legacy token file: ${String(error)}`)
    }
  }
  return file.accounts
}

/** Add-or-refresh one account's tokens; returns the updated roster. */
export function saveAccountTokens(userDataDir: string, tokens: TokenSet): StoredAccount[] {
  const accounts = upsertAccount(loadAccounts(userDataDir), tokens)
  write(userDataDir, accounts)
  return accounts
}

/** Remove one account's tokens; returns the updated roster. */
export function removeAccountTokens(userDataDir: string, accountId: string): StoredAccount[] {
  const accounts = removeAccount(loadAccounts(userDataDir), accountId)
  if (accounts.length === 0) rmSync(join(userDataDir, FILE), { force: true })
  else write(userDataDir, accounts)
  return accounts
}

/**
 * Persist a new switcher order (F15). Reordering re-reads the file first so a
 * token refresh that landed after the caller's snapshot keeps its newest
 * tokens; validation against that fresh roster is what rejects stale requests.
 * A failed write throws before anything is returned, leaving the old order.
 */
export function reorderAccountTokens(userDataDir: string, ids: readonly string[]): StoredAccount[] {
  const accounts = reorderRoster(loadAccounts(userDataDir), ids)
  write(userDataDir, accounts)
  return accounts
}

export function clearTokens(userDataDir: string): void {
  rmSync(join(userDataDir, FILE), { force: true })
}
