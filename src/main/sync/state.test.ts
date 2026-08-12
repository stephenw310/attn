import { describe, expect, it } from 'vitest'
import { sameSyncState } from './state'

describe('sync state publication', () => {
  it('dedupes identical idle, progress, and error states', () => {
    expect(sameSyncState({ phase: 'idle' }, { phase: 'idle' })).toBe(true)
    expect(sameSyncState({ phase: 'syncing', threadsDone: 4 }, { phase: 'syncing', threadsDone: 4 })).toBe(
      true
    )
    expect(
      sameSyncState({ phase: 'error', message: 'offline' }, { phase: 'error', message: 'offline' })
    ).toBe(true)
  })

  it('publishes phase, progress, and error changes', () => {
    expect(sameSyncState({ phase: 'idle' }, { phase: 'syncing', threadsDone: 0 })).toBe(false)
    expect(sameSyncState({ phase: 'syncing', threadsDone: 4 }, { phase: 'syncing', threadsDone: 5 })).toBe(
      false
    )
    expect(sameSyncState({ phase: 'error', message: 'offline' }, { phase: 'error', message: 'quota' })).toBe(
      false
    )
  })
})
