import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { ActionExecutor } from './executor'

interface FakeRow {
  id: number
  account_id: string
  kind: 'modifyLabels'
  thread_id: string
  payload: string
  attempts: number
  state: 'pending' | 'inflight' | 'failed'
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
        }
        return { changes: 1 }
      },
      get: (accountId: unknown) => rows.find((row) => row.account_id === accountId && row.state === 'pending')
    })
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

describe('action executor', () => {
  it('drains only the active account and notifies after success', async () => {
    const rows = [row(1, 'a@example.com', 'a-thread'), row(2, 'b@example.com', 'b-thread')]
    const provider = {
      modifyThread: vi.fn(async () => {}),
      trashThread: vi.fn(async () => {}),
      untrashThread: vi.fn(async () => {})
    } satisfies MailActionProvider
    const notify = vi.fn()
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => provider,
      notify
    )
    await executor.trigger()
    expect(provider.modifyThread).toHaveBeenCalledOnce()
    expect(provider.modifyThread).toHaveBeenCalledWith('a-thread', [], ['INBOX'])
    expect(rows.map((item) => item.thread_id)).toEqual(['b-thread'])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('continues past a permanent failure to later rows', async () => {
    const rows = [row(1, 'a@example.com', 'bad'), row(2, 'a@example.com', 'good')]
    const provider = {
      modifyThread: vi
        .fn()
        .mockRejectedValueOnce(new GmailApiError(400, 'bad request'))
        .mockResolvedValue(undefined),
      trashThread: vi.fn(async () => {}),
      untrashThread: vi.fn(async () => {})
    } satisfies MailActionProvider
    const executor = new ActionExecutor(
      fakeDb(rows),
      () => 'a@example.com',
      () => provider
    )
    await executor.trigger()
    expect(provider.modifyThread).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ thread_id: 'bad', state: 'failed', attempts: 1 })
  })
})
