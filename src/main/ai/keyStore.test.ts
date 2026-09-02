import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AiKeyStore, type SecretCipher } from './keyStore'

// A reversible fake safeStorage: enough to prove round-trip behavior and that
// the file on disk never holds the plaintext key.
function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (data) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not ciphertext')
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    }
  }
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'attn-ai-key-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AiKeyStore', () => {
  it('round-trips a key and reports presence', () => {
    const store = new AiKeyStore(tempDir(), fakeCipher())
    expect(store.present()).toBe(false)
    expect(store.load()).toBeNull()
    store.save('sk-test-123')
    expect(store.present()).toBe(true)
    expect(store.load()).toBe('sk-test-123')
  })

  it('writes only ciphertext to disk', () => {
    const dir = tempDir()
    const store = new AiKeyStore(dir, fakeCipher())
    store.save('sk-secret-value')
    const onDisk = readFileSync(join(dir, 'ai-key.bin'), 'utf8')
    expect(onDisk).not.toContain('sk-secret-value')
  })

  it('delete removes the key and is idempotent', () => {
    const store = new AiKeyStore(tempDir(), fakeCipher())
    store.save('sk-test-123')
    store.delete()
    expect(store.load()).toBeNull()
    store.delete()
    expect(store.present()).toBe(false)
  })

  it('refuses to store when OS encryption is unavailable', () => {
    const store = new AiKeyStore(tempDir(), fakeCipher(false))
    expect(() => store.save('sk-test-123')).toThrow(/encryption unavailable/)
    expect(store.present()).toBe(false)
  })

  it('an unreadable or corrupt file reads as no key, never a throw', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ai-key.bin'), 'garbage-not-ciphertext')
    const store = new AiKeyStore(dir, fakeCipher())
    expect(store.load()).toBeNull()
    expect(store.present()).toBe(false)
  })

  it('rejects saving an empty key', () => {
    const store = new AiKeyStore(tempDir(), fakeCipher())
    expect(() => store.save('')).toThrow(/empty/)
  })
})
