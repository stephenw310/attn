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
    expect(
      sameSyncState(
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          threadsTotal: 100,
          etaMs: 60_000,
          reason: 'quota-wait',
          waitMs: 1_000
        },
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          threadsTotal: 100,
          etaMs: 60_000,
          reason: 'quota-wait',
          waitMs: 1_000
        }
      )
    ).toBe(true)
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
        { phase: 'syncing', stage: 'metadata', threadsDone: 4, stageThreadsPerMinute: 120 },
        { phase: 'syncing', stage: 'metadata', threadsDone: 4, stageThreadsPerMinute: 121 }
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
    expect(
      sameSyncState(
        { phase: 'indexing', stage: 'lifetime', threadsDone: 50, reason: 'running' },
        { phase: 'indexing', stage: 'lifetime', threadsDone: 51, reason: 'running' }
      )
    ).toBe(false)
    expect(
      sameSyncState(
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          quotaWaitMs: 100,
          reason: 'running'
        },
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          quotaWaitMs: 101,
          reason: 'running'
        }
      )
    ).toBe(false)
    expect(
      sameSyncState(
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          reason: 'retry-wait',
          message: 'quota'
        },
        {
          phase: 'indexing',
          stage: 'lifetime',
          threadsDone: 50,
          reason: 'retry-wait',
          message: 'offline'
        }
      )
    ).toBe(false)
  })
})
