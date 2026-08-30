import { describe, expect, it } from 'vitest'
import { accountSyncPhase } from './auth'

describe('accountSyncPhase', () => {
  it('maps each sync phase to the menu one-liner', () => {
    expect(accountSyncPhase({ phase: 'idle' }, false)).toBe('live')
    expect(accountSyncPhase({ phase: 'checking' }, false)).toBe('syncing')
    expect(accountSyncPhase({ phase: 'syncing', stage: 'metadata', threadsDone: 3 }, false)).toBe('syncing')
    expect(
      accountSyncPhase({ phase: 'indexing', stage: 'lifetime', threadsDone: 9, reason: 'running' }, false)
    ).toBe('syncing')
    expect(accountSyncPhase({ phase: 'offline', message: 'net down' }, false)).toBe('offline')
    expect(accountSyncPhase({ phase: 'error', message: 'boom' }, false)).toBe('error')
  })

  it('lets an auth-paused queue outrank every sync phase', () => {
    // The account needs the user; any other word would hide that behind a
    // switch (F18 — background failures must be discoverable from the menu).
    expect(accountSyncPhase({ phase: 'idle' }, true)).toBe('reconnect')
    expect(accountSyncPhase({ phase: 'offline', message: 'net down' }, true)).toBe('reconnect')
  })
})
