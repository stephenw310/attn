import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { nonDraftMessages, pruneMissingMessages } from './persist'

describe('thread snapshot persistence', () => {
  it('excludes Gmail draft messages from the ordinary conversation snapshot', () => {
    const real = { id: 'sent', threadId: 'thread', labelIds: ['SENT'], snippet: 'Sent copy' }
    const draft = { id: 'draft', threadId: 'thread', labelIds: ['DRAFT'], snippet: 'Unsent copy' }
    expect(nonDraftMessages([real, draft])).toEqual([real])
  })

  it('prunes messages absent from the latest surviving thread snapshot', () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const statements: string[] = []
    const db = {
      prepare: (statement: string) => {
        statements.push(statement)
        return {
          all: vi.fn(() => (statement.includes('SELECT DISTINCT cm.email') ? [{ email: 'old@test' }] : [])),
          get: vi.fn(() => undefined),
          run: (...params: unknown[]) => calls.push({ sql: statement, params })
        }
      },
      transaction: (callback: () => void) => callback
    } as unknown as Db

    pruneMissingMessages(db, 'account', 'thread', ['m2', 'm3'])

    expect(statements.filter((sql) => sql.includes('id NOT IN (?, ?)'))).toHaveLength(3)
    expect(calls).toContainEqual({
      sql: expect.stringContaining('DELETE FROM messages'),
      params: ['account', 'thread', 'm2', 'm3']
    })
    expect(calls).toContainEqual({
      sql: 'DELETE FROM contacts WHERE account_id = ? AND email = ?',
      params: ['account', 'old@test']
    })
  })
})
