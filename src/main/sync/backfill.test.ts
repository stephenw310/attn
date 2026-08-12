import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { runInboxBackfill } from './backfill'
import type { MailProvider } from './provider'

interface FakeSyncState {
  backfill_cursor: string | null
  updated_at: number | null
  last_history_id?: string
}

function fakeDb(state: FakeSyncState | undefined): Db {
  return {
    prepare: (sql: string) => ({
      get: () => (sql.startsWith('SELECT backfill_cursor') ? state : undefined),
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sync_state')) {
          state = { backfill_cursor: 'start', updated_at: 0, last_history_id: args[1] as string }
        } else if (sql.includes('UPDATE sync_state SET backfill_cursor')) {
          if (!state) state = { backfill_cursor: null, updated_at: null }
          state.backfill_cursor = args[0] as string
          state.updated_at = args.length === 3 ? (args[1] as number) : 0
        }
        return { changes: 1 }
      }
    }),
    transaction: (fn: () => void) => fn
  } as unknown as Db
}

function emptyProvider(): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'test@example.com', historyId: '101' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async () => ({ id: 'unused' })),
    listHistory: vi.fn(async () => ({ history: [], historyId: '101' }))
  }
}

const callbacks = {
  onProgress: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn()
}

describe('windowed backfill checkpoints', () => {
  it('checkpoints before page one and completes a separate reconciliation listing', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.listThreadIds).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ accountId: 'test@example.com', threadCount: 0, inboxThreadIds: [] })
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('resumes directly at reconciliation without replaying body pages', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(
      fakeDb({ backfill_cursor: 'reconcile', updated_at: 0, last_history_id: '88' }),
      provider,
      callbacks
    )

    expect(provider.listThreadIds).toHaveBeenCalledOnce()
    expect(provider.getThread).not.toHaveBeenCalled()
    expect(result).not.toBeNull()
  })
})
