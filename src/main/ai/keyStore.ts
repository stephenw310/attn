// Encrypted LLM-provider key custody (F17, §6). Follows the OAuth tokens'
// encrypted-file pattern but stays deliberately separate: deleting the AI key
// removes ai-key.bin and never touches tokens.bin or anything OAuth. The key
// is never written to SQLite (the settings table is plaintext) and never
// logged. The cipher is injected so unit tests run against a fake safeStorage
// without Electron.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SecretCipher {
  isAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

const FILE = 'ai-key.bin'

export class AiKeyStore {
  constructor(
    private readonly userDataDir: string,
    private readonly cipher: SecretCipher
  ) {}

  private path(): string {
    return join(this.userDataDir, FILE)
  }

  present(): boolean {
    return this.load() !== null
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
