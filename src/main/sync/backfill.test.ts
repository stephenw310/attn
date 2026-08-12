import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { runInboxBackfill } from './backfill'
import type { MailProvider, ThreadIdPage } from './provider'

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
          state = { backfill_cursor: 'metadata', updated_at: 0, last_history_id: args[1] as string }
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
    getThread: vi.fn(async (id) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '101' }))
  }
}

let callbacks: { onProgress: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> }

beforeEach(() => {
  callbacks = { onProgress: vi.fn(), onError: vi.fn() }
})

describe('windowed backfill checkpoints', () => {
  it('runs 12-month metadata before 90-day bodies and a separate reconciliation listing', async () => {
    const provider = emptyProvider()
    const result = await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, 'newer_than:12m', undefined)
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, 'newer_than:90d', undefined)
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(3, '', undefined)
    expect(result).toEqual({ threadCount: 0, inboxThreadIds: [] })
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('requests metadata and full snapshots in their respective phases', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.listThreadIds)
      .mockResolvedValueOnce({ threadIds: ['old'] })
      .mockResolvedValueOnce({ threadIds: ['recent'] })
      .mockResolvedValueOnce({ threadIds: ['old', 'recent'] })

    await runInboxBackfill(fakeDb(undefined), provider, callbacks)

    expect(provider.getThread).toHaveBeenNthCalledWith(1, 'old', { format: 'metadata' })
    expect(provider.getThread).toHaveBeenNthCalledWith(2, 'recent', { format: 'full' })
  })

  it('resumes directly at reconciliation without replaying fetch phases', async () => {
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

  it('drops an expired saved page token and restarts that phase once', async () => {
    const provider = emptyProvider()
    vi.mocked(provider.listThreadIds).mockImplementation(async (_query, token): Promise<ThreadIdPage> => {
      if (token === 'expired') throw new GmailApiError(400, 'invalid page token')
      return { threadIds: [] }
    })

    const result = await runInboxBackfill(
      fakeDb({ backfill_cursor: 'metadata:expired', updated_at: 0, last_history_id: '88' }),
      provider,
      callbacks
    )

    expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, 'newer_than:12m', 'expired')
    expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, 'newer_than:12m', undefined)
    expect(result).not.toBeNull()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})
