import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { ActionExecutor, type ActionRecoveryProvider } from './executor'

interface FakeRow {
  id: number
  account_id: string
  kind: 'modifyLabels'
  thread_id: string
  payload: string
  attempts: number
  state: 'pending' | 'inflight' | 'failed'
  last_error?: string | null
}

function fakeDb(rows: FakeRow[]): Db {
  return {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("SET state = 'pending' WHERE state = 'inflight'")) {
          for (const row of rows) if (row.state === 'inflight') row.state = 'pending'
        } else if (sql.includes("SET state = 'inflight'")) {
          const row = rows.find((item) => item.id === args[0])
          if (row) row.state = 'inflight'
        } else if (sql.startsWith('DELETE')) {
          const index = rows.findIndex((item) => item.id === args[0])
          if (index >= 0) rows.splice(index, 1)
        } else if (sql.includes('SET state = ?, attempts')) {
          const row = rows.find((item) => item.id === args[2])
          if (row) {
            row.state = args[0] as FakeRow['state']
            row.attempts++
          }
        } else if (sql.includes("SET state = 'pending', attempts")) {
          const row = rows.find((item) => item.id === args[1])
          if (row) {
            row.state = 'pending'
            row.attempts++
            row.last_error = String(args[0])
          }
        } else if (sql.includes("SET state = 'pending' WHERE id")) {
          const row = rows.find((item) => item.id === args[0])
          if (row) row.state = 'pending'
        }
        return { changes: 1 }
      },
      get: (accountId: unknown) =>
        sql.includes('FROM action_queue aq')
          ? rows.find((row) => row.account_id === accountId && row.state === 'pending')
          : undefined,
      all: (accountId: unknown) =>
        sql.includes("state = 'failed'")
          ? rows.filter((row) => row.account_id === accountId && row.state === 'failed')
          : []
    }),
    transaction: (callback: () => unknown) => callback
  } as unknown as Db
}

function row(id: number, accountId: string, threadId: string): FakeRow {
  return {
    id,
    account_id: accountId,
    kind: 'modifyLabels',
    thread_id: threadId,
    payload: '{"add":[],"remove":["INBOX"]}',
    attempts: 0,
    state: 'pending'
  }
}

function snapshot(threadId: string): GmailThread {
  return {
    id: threadId,
    messages: [
      {
        id: `${threadId}-message`,
        threadId,
        labelIds: ['INBOX'],
        internalDate: '1',
        snippet: 'Server truth',
        payload: {
          headers: [
            { name: 'From', value: 'Maya <maya@example.com>' },
            { name: 'Subject', value: 'Roadmap' }
          ]
        }
      }
    ]
  }
}

function provider(
  modifyThread: ActionRecoveryProvider['modifyThread'] = vi.fn(async () => {})
): ActionRecoveryProvider {
  return {
    modifyThread,
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getThread: vi.fn(async (threadId) => snapshot(threadId))
  }
}

describe('action executor', () => {
  it('drains only the active account and notifies after success', async () => {
    const rows = [row(1, 'a@example.com', 'a-thread'), row(2, 'b@example.com', 'b-thread')]
    const actionProvider = provider()
    const notify = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      notify
    )
    await executor.trigger()
    expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
    expect(actionProvider.modifyThread).toHaveBeenCalledWith('a-thread', [], ['INBOX'])
    expect(rows.map((item) => item.thread_id)).toEqual(['b-thread'])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('refetches server truth, deletes a permanently failed row, and continues', async () => {
    const rows = [row(1, 'a@example.com', 'bad'), row(2, 'a@example.com', 'good')]
    const actionProvider = provider(
      vi.fn().mockRejectedValueOnce(new GmailApiError(400, 'bad request')).mockResolvedValue(undefined)
    )
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )
    await executor.trigger()
    expect(actionProvider.modifyThread).toHaveBeenCalledTimes(2)
    expect(actionProvider.getThread).toHaveBeenCalledWith('bad', { format: 'full' })
    expect(rows).toHaveLength(0)
    expect(onReverted).toHaveBeenCalledOnce()
    expect(onReverted).toHaveBeenCalledWith([
      expect.objectContaining({ threadId: 'bad', kind: 'archive', returnedToInbox: true })
    ])
  })

  it('keeps auth failures pending without arming transient backoff', async () => {
    vi.useFakeTimers()
    try {
      const rows = [row(1, 'a@example.com', 'auth')]
      const actionProvider = provider(
        vi.fn(async () => {
          throw new GmailApiError(401, 'gmail /threads/auth/modify failed (401): revoked')
        })
      )
      const onReverted = vi.fn()
      const executor = new ActionExecutor(
        fakeDb(rows),
        () => 'a@example.com',
        () => actionProvider,
        undefined,
        onReverted
      )

      await executor.trigger()

      expect(rows[0]).toMatchObject({ state: 'pending', attempts: 1 })
      expect(actionProvider.getThread).not.toHaveBeenCalled()
      expect(onReverted).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      executor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-pends legacy stored 401 rows only after successful auth calls the hook', () => {
    const auth = row(1, 'a@example.com', 'auth')
    auth.state = 'failed'
    auth.last_error = 'gmail /threads/auth/modify failed (401): revoked'
    const permanent = row(2, 'a@example.com', 'bad')
    permanent.state = 'failed'
    permanent.last_error = 'gmail /threads/bad/modify failed (400): bad request'
    const executor = new ActionExecutor(
      fakeDb([auth, permanent]),
      () => null,
      () => null
    )

    expect(executor.resumeAuthFailures('a@example.com')).toBe(1)
    expect(auth.state).toBe('pending')
    expect(permanent.state).toBe('failed')
  })

  it('self-heals a legacy permanently failed row on the next online drain', async () => {
    const legacy = row(1, 'a@example.com', 'legacy')
    legacy.state = 'failed'
    legacy.last_error = 'gmail /threads/legacy/modify failed (400): bad request'
    const actionProvider = provider(
      vi.fn(async () => {
        throw new GmailApiError(400, 'bad request')
      })
    )
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb([legacy]),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await executor.trigger()

    expect(actionProvider.getThread).toHaveBeenCalledWith('legacy', { format: 'full' })
    expect(onReverted).toHaveBeenCalledOnce()
  })

  it('keeps the row pending when the authoritative recovery refetch is offline', async () => {
    vi.useFakeTimers()
    try {
      const pending = row(1, 'a@example.com', 'offline-recovery')
      const actionProvider = provider(
        vi.fn(async () => {
          throw new GmailApiError(400, 'bad request')
        })
      )
      vi.mocked(actionProvider.getThread).mockRejectedValue(new TypeError('fetch failed'))
      const onReverted = vi.fn()
      const executor = new ActionExecutor(
        fakeDb([pending]),
        () => 'a@example.com',
        () => actionProvider,
        undefined,
        onReverted
      )

      await executor.trigger()

      expect(pending).toMatchObject({ state: 'pending', attempts: 1 })
      expect(onReverted).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      executor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let external nudges bypass transient retry backoff', async () => {
    vi.useFakeTimers()
    try {
      const rows = [row(1, 'a@example.com', 'retry')]
      const actionProvider = provider(
        vi
          .fn()
          .mockRejectedValueOnce(new GmailApiError(503, 'unavailable', true))
          .mockResolvedValue(undefined)
      )
      const executor = new ActionExecutor(
        fakeDb(rows),
        () => 'a@example.com',
        () => actionProvider
      )

      await executor.trigger()
      await executor.trigger()
      expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
      expect(actionProvider.getThread).not.toHaveBeenCalled()

      expect(vi.getTimerCount()).toBe(1)
      await vi.runAllTimersAsync()
      await Promise.resolve()
      await Promise.resolve()
      expect(actionProvider.modifyThread).toHaveBeenCalledTimes(2)
      expect(rows).toHaveLength(0)
      executor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
