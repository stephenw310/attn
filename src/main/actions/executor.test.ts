import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { isStoredAuthActionError, storeActionError } from './execute'
import { ActionExecutor, type ActionRecoveryProvider } from './executor'

interface FakeRow {
  id: number
  account_id: string
  kind: 'modifyLabels'
  thread_id: string
  payload: string
  attempts: number
  state: 'pending' | 'inflight' | 'recovering' | 'failed'
  last_error?: string | null
}

function fakeDb(rows: FakeRow[]): Db {
  return {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        let changes = 0
        if (sql.includes("SET state = 'pending' WHERE state = 'inflight'")) {
          for (const row of rows) {
            if (row.state !== 'inflight') continue
            row.state = 'pending'
            changes++
          }
        } else if (sql.includes("SET state = 'inflight'")) {
          const row = rows.find(
            (item) => item.account_id === args[0] && item.id === args[1] && item.state === 'pending'
          )
          if (row) {
            row.state = 'inflight'
            changes = 1
          }
        } else if (sql.startsWith('DELETE FROM action_queue')) {
          const index = rows.findIndex((item) => item.account_id === args[0] && item.id === args[1])
          if (index >= 0) {
            rows.splice(index, 1)
            changes = 1
          }
        } else if (sql.includes('SET state = ?, attempts = 0')) {
          const row = rows.find((item) => item.id === args[2])
          if (row) {
            row.state = args[0] as FakeRow['state']
            row.attempts = 0
            row.last_error = null
            changes = 1
          }
        } else if (sql.includes('SET state = ?, last_error = ?')) {
          const row = rows.find((item) => item.account_id === args[2] && item.id === args[3])
          if (row) {
            row.state = args[0] as FakeRow['state']
            row.last_error = args[1] as string | null
            changes = 1
          }
        } else if (sql.includes("SET state = 'pending', attempts")) {
          const row = rows.find((item) => item.account_id === args[1] && item.id === args[2])
          if (row) {
            row.state = 'pending'
            row.attempts++
            row.last_error = String(args[0])
            changes = 1
          }
        } else if (sql.includes("SET state = 'recovering', attempts")) {
          const row = rows.find((item) => item.account_id === args[2] && item.id === args[3])
          if (row) {
            row.state = 'recovering'
            row.attempts += Number(args[0])
            row.last_error = String(args[1])
            changes = 1
          }
        } else if (sql.includes("SET state = 'recovering' WHERE account_id")) {
          const row = rows.find((item) => item.account_id === args[0] && item.id === args[1])
          if (row) {
            row.state = 'recovering'
            changes = 1
          }
        } else if (sql.includes("SET state = 'pending' WHERE account_id")) {
          const row = rows.find((item) => item.account_id === args[0] && item.id === args[1])
          if (row) {
            row.state = 'pending'
            changes = 1
          }
        }
        return { changes }
      },
      get: (accountId: unknown) =>
        sql.includes('FROM action_queue aq')
          ? rows.find(
              (row) => row.account_id === accountId && (row.state === 'pending' || row.state === 'recovering')
            )
          : undefined,
      all: (accountId?: unknown) => {
        if (sql.includes("state IN ('pending', 'recovering', 'failed')")) {
          if (!sql.includes('account_id = ?')) {
            return rows.filter(
              (row) => row.state === 'pending' || row.state === 'recovering' || row.state === 'failed'
            )
          }
          return rows.filter(
            (row) =>
              row.account_id === accountId &&
              (row.state === 'pending' || row.state === 'recovering' || row.state === 'failed')
          )
        }
        return sql.includes("state = 'failed'")
          ? rows.filter((row) => row.account_id === accountId && row.state === 'failed')
          : []
      }
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
    expect(onReverted).toHaveBeenCalledWith('a@example.com', [
      expect.objectContaining({ threadId: 'bad', kind: 'archive', returnedToInbox: true })
    ])
  })

  it('keeps auth failures paused until successful authentication resumes them', async () => {
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
      await executor.trigger()

      expect(rows[0]).toMatchObject({
        state: 'pending',
        attempts: 1
      })
      expect(isStoredAuthActionError(rows[0].last_error)).toBe(true)
      expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
      expect(actionProvider.getThread).not.toHaveBeenCalled()
      expect(onReverted).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(executor.resumeAuthFailures('a@example.com')).toBe(1)
      expect(rows[0]).toMatchObject({ state: 'pending', attempts: 0, last_error: null })
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
    expect(auth).toMatchObject({ state: 'pending', attempts: 0, last_error: null })
    expect(permanent.state).toBe('recovering')
  })

  it('makes a legacy auth failure visible but does not retry it during startup', async () => {
    const auth = row(1, 'a@example.com', 'auth')
    auth.state = 'failed'
    auth.last_error = 'gmail /threads/auth/modify failed (401): revoked'
    const actionProvider = provider()
    const executor = new ActionExecutor(
      fakeDb([auth]),
      () => 'a@example.com',
      () => actionProvider
    )

    await executor.trigger()

    expect(auth.state).toBe('pending')
    expect(actionProvider.modifyThread).not.toHaveBeenCalled()
  })

  it('does not wrap an already-typed auth marker again during startup', () => {
    const auth = row(1, 'a@example.com', 'auth')
    const marker = storeActionError(new GmailApiError(401, 'revoked'), 'auth')
    auth.last_error = marker

    new ActionExecutor(
      fakeDb([auth]),
      () => null,
      () => null
    )

    expect(auth.last_error).toBe(marker)
  })

  it('self-heals a legacy permanently failed row on the next online drain', async () => {
    const legacy = row(1, 'a@example.com', 'legacy')
    legacy.state = 'failed'
    legacy.last_error = 'gmail /threads/legacy/modify failed (400): bad request'
    const actionProvider = provider()
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb([legacy]),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await executor.trigger()

    expect(actionProvider.modifyThread).not.toHaveBeenCalled()
    expect(actionProvider.getThread).toHaveBeenCalledWith('legacy', { format: 'full' })
    expect(onReverted).toHaveBeenCalledOnce()
  })

  it('retries only the authoritative refetch after recovery goes offline', async () => {
    vi.useFakeTimers()
    try {
      const pending = row(1, 'a@example.com', 'offline-recovery')
      const rows = [pending]
      const actionProvider = provider(
        vi.fn(async () => {
          throw new GmailApiError(400, 'bad request')
        })
      )
      vi.mocked(actionProvider.getThread)
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue(snapshot('offline-recovery'))
      const onReverted = vi.fn()
      const executor = new ActionExecutor(
        fakeDb(rows),
        () => 'a@example.com',
        () => actionProvider,
        undefined,
        onReverted
      )

      await executor.trigger()
      await executor.trigger()

      expect(pending).toMatchObject({ state: 'recovering', attempts: 1 })
      expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
      expect(onReverted).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      await vi.runAllTimersAsync()
      await Promise.resolve()
      await Promise.resolve()
      expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
      expect(actionProvider.getThread).toHaveBeenCalledTimes(2)
      expect(onReverted).toHaveBeenCalledOnce()
      expect(rows).toHaveLength(0)
      executor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes an auth-paused recovery without resending the rejected action', async () => {
    const recovering = row(1, 'a@example.com', 'auth-recovery')
    const rows = [recovering]
    const actionProvider = provider(
      vi.fn(async () => {
        throw new GmailApiError(400, 'bad request')
      })
    )
    vi.mocked(actionProvider.getThread)
      .mockRejectedValueOnce(new GmailApiError(401, 'gmail /threads/auth-recovery failed (401): revoked'))
      .mockResolvedValue(snapshot('auth-recovery'))
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await executor.trigger()
    await executor.trigger()

    expect(recovering).toMatchObject({
      state: 'recovering'
    })
    expect(isStoredAuthActionError(recovering.last_error)).toBe(true)
    expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
    expect(actionProvider.getThread).toHaveBeenCalledOnce()
    expect(executor.resumeAuthFailures('a@example.com')).toBe(1)

    await executor.trigger()

    expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
    expect(actionProvider.getThread).toHaveBeenCalledTimes(2)
    expect(onReverted).toHaveBeenCalledOnce()
    expect(rows).toHaveLength(0)
  })

  it('refetches after a mutation 404 instead of deleting cached mail', async () => {
    const rows = [row(1, 'a@example.com', 'gone')]
    const actionProvider = provider(
      vi.fn(async () => {
        throw new GmailApiError(404, 'gone')
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

    expect(rows).toHaveLength(0)
    expect(actionProvider.getThread).toHaveBeenCalledWith('gone', { format: 'full' })
    expect(onReverted).toHaveBeenCalledWith('a@example.com', [
      expect.objectContaining({ threadId: 'gone', resolution: 'restored' })
    ])
  })

  it('drops only the queue row when a permanent refetch failure cannot restore server truth', async () => {
    const rows = [row(1, 'a@example.com', 'unavailable'), row(2, 'a@example.com', 'good')]
    const actionProvider = provider(
      vi.fn().mockRejectedValueOnce(new GmailApiError(400, 'bad mutation')).mockResolvedValue(undefined)
    )
    vi.mocked(actionProvider.getThread).mockRejectedValueOnce(new GmailApiError(404, 'not found'))
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await executor.trigger()

    expect(rows).toHaveLength(0)
    expect(actionProvider.modifyThread).toHaveBeenCalledTimes(2)
    expect(actionProvider.getThread).toHaveBeenCalledOnce()
    expect(onReverted).toHaveBeenCalledWith('a@example.com', [
      expect.objectContaining({ threadId: 'unavailable', resolution: 'unavailable' })
    ])
  })

  it('treats an empty authoritative response as unavailable without blocking later actions', async () => {
    const rows = [row(1, 'a@example.com', 'empty'), row(2, 'a@example.com', 'good')]
    const actionProvider = provider(
      vi.fn().mockRejectedValueOnce(new GmailApiError(400, 'bad mutation')).mockResolvedValue(undefined)
    )
    vi.mocked(actionProvider.getThread).mockResolvedValueOnce({ id: 'empty', messages: [] })
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await executor.trigger()

    expect(rows).toHaveLength(0)
    expect(actionProvider.modifyThread).toHaveBeenCalledTimes(2)
    expect(onReverted).toHaveBeenCalledWith('a@example.com', [
      expect.objectContaining({ threadId: 'empty', resolution: 'unavailable' })
    ])
  })

  it('recovers a corrupt payload without rejecting drain or blocking later actions', async () => {
    const corrupt = row(1, 'a@example.com', 'corrupt')
    corrupt.payload = '{not-json'
    const rows = [corrupt, row(2, 'a@example.com', 'good')]
    const actionProvider = provider()
    const onReverted = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => actionProvider,
      undefined,
      onReverted
    )

    await expect(executor.trigger()).resolves.toBeUndefined()

    expect(actionProvider.modifyThread).toHaveBeenCalledOnce()
    expect(actionProvider.modifyThread).toHaveBeenCalledWith('good', [], ['INBOX'])
    expect(actionProvider.getThread).toHaveBeenCalledWith('corrupt', { format: 'full' })
    expect(rows).toHaveLength(0)
    expect(onReverted).toHaveBeenCalledWith('a@example.com', [
      expect.objectContaining({ threadId: 'corrupt', kind: 'labels', resolution: 'restored' })
    ])
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

  it('does not let one account retry timer block a newly active account', async () => {
    vi.useFakeTimers()
    try {
      const rows = [row(1, 'a@example.com', 'a-retry'), row(2, 'b@example.com', 'b-ready')]
      let activeAccount = 'a@example.com'
      const actionProvider = provider(
        vi
          .fn()
          .mockRejectedValueOnce(new GmailApiError(503, 'unavailable', true))
          .mockResolvedValue(undefined)
      )
      const executor = new ActionExecutor(
        fakeDb(rows),
        () => activeAccount,
        () => actionProvider
      )

      await executor.trigger()
      expect(vi.getTimerCount()).toBe(1)

      activeAccount = 'b@example.com'
      await executor.trigger()

      expect(actionProvider.modifyThread).toHaveBeenCalledTimes(2)
      expect(rows.map((item) => item.thread_id)).toEqual(['a-retry'])
      expect(vi.getTimerCount()).toBe(0)
      executor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
