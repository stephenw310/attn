// Encrypted token persistence via Electron safeStorage
// (macOS Keychain-backed / Windows DPAPI — SPEC F1, §6 Security).

import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TokenSet } from './googleAuth'

const FILE = 'tokens.bin'

export function saveTokens(userDataDir: string, tokens: TokenSet): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption unavailable; refusing to store tokens in plaintext')
  }
  writeFileSync(join(userDataDir, FILE), safeStorage.encryptString(JSON.stringify(tokens)))
}

export function loadTokens(userDataDir: string): TokenSet | null {
  const path = join(userDataDir, FILE)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(path))) as TokenSet
  } catch {
    return null
  }
}

export function clearTokens(userDataDir: string): void {
  rmSync(join(userDataDir, FILE), { force: true })
}
