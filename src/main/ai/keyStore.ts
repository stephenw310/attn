// Encrypted provider key custody (F17, §6). Follows the OAuth tokens'
// encrypted-file pattern but stays deliberately separate: each store owns one
// file, so deleting a key removes only that file and never touches tokens.bin,
// anything OAuth, or the other store's file. The writing-provider key lives in
// ai-key.bin and the TypeSafe smart-splits key in typesafe-key.bin; removing
// one leaves the other intact. A key is never written to SQLite (the settings
// table is plaintext) and never logged. The cipher is injected so unit tests
// run against a fake safeStorage without Electron.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SecretCipher {
  isAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

const AI_KEY_FILE = 'ai-key.bin'

/** The smart-splits key file; deleting it never touches `ai-key.bin`. */
export const TYPESAFE_KEY_FILE = 'typesafe-key.bin'

export class AiKeyStore {
  constructor(
    private readonly userDataDir: string,
    private readonly cipher: SecretCipher,
    private readonly file: string = AI_KEY_FILE
  ) {}

  private path(): string {
    return join(this.userDataDir, this.file)
  }

  present(): boolean {
    return this.load() !== null
  }

  /** Safe display identifier. Short keys remain completely masked. */
  preview(): string | null {
    const key = this.load()
    if (!key) return null
    if (key.length <= 12) return '••••••••'
    return `${key.slice(0, 4)}••••••••${key.slice(-4)}`
  }

  /** The stored key, or null when absent or unreadable (never a throw). */
  load(): string | null {
    const path = this.path()
    if (!existsSync(path)) return null
    try {
      const key = this.cipher.decryptString(readFileSync(path))
      return key.length > 0 ? key : null
    } catch {
      return null
    }
  }

  save(key: string): void {
    if (key.length === 0) throw new Error('empty AI provider key')
    if (!this.cipher.isAvailable()) {
      throw new Error('OS-level encryption unavailable; refusing to store the AI key in plaintext')
    }
    writeFileSync(this.path(), this.cipher.encryptString(key))
  }

  delete(): void {
    rmSync(this.path(), { force: true })
  }
}
