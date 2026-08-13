import { describe, expect, it } from 'vitest'
import { sameSyncState } from './state'

describe('sync state publication', () => {
  it('dedupes identical idle, progress, and error states', () => {
    expect(sameSyncState({ phase: 'idle' }, { phase: 'idle' })).toBe(true)
    expect(
      sameSyncState(
        { phase: 'syncing', stage: 'bodies', threadsDone: 4 },
        { phase: 'syncing', stage: 'bodies', threadsDone: 4 }
      )
    ).toBe(true)
    expect(
      sameSyncState(
        { phase: 'offline', message: 'fetch failed' },
        { phase: 'offline', message: 'fetch failed' }
      )
    ).toBe(true)
    expect(
      sameSyncState({ phase: 'error', message: 'offline' }, { phase: 'error', message: 'offline' })
    ).toBe(true)
    expect(sameSyncState({ phase: 'checking' }, { phase: 'checking' })).toBe(true)
  })

  it('publishes phase, progress, and error changes', () => {
    expect(sameSyncState({ phase: 'idle' }, { phase: 'syncing', stage: 'metadata', threadsDone: 0 })).toBe(
      false
    )
    expect(
      sameSyncState(
        { phase: 'syncing', stage: 'metadata', threadsDone: 4 },
        { phase: 'syncing', stage: 'metadata', threadsDone: 5 }
      )
    ).toBe(false)
    expect(
      sameSyncState(
        { phase: 'syncing', stage: 'metadata', threadsDone: 4 },
        { phase: 'syncing', stage: 'bodies', threadsDone: 4 }
      )
    ).toBe(false)
    expect(sameSyncState({ phase: 'error', message: 'offline' }, { phase: 'error', message: 'quota' })).toBe(
      false
    )
    expect(sameSyncState({ phase: 'checking' }, { phase: 'idle' })).toBe(false)
    expect(
      sameSyncState({ phase: 'checking' }, { phase: 'syncing', stage: 'reconcile', threadsDone: 0 })
    ).toBe(false)
  })
})
