import { describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { nonDraftMessages, persistThread, planLabelCatalogUpdate, upsertLabels } from './persist'

describe('label catalog persistence', () => {
  it('plans additions, renames, and deletions from an authoritative listing', () => {
    expect(
      planLabelCatalogUpdate(
        [
          { id: 'kept', name: 'Kept', type: 'system' },
          { id: 'renamed', name: 'Old name', type: 'user' },
          { id: 'deleted', name: 'Deleted', type: 'user' }
        ],
        [
          { id: 'kept', name: 'Kept', type: 'system' },
          { id: 'renamed', name: 'New name', type: 'user' },
          { id: 'added', name: 'Added', type: 'user' }
        ]
      )
    ).toEqual({
      upsert: [
        { id: 'renamed', name: 'New name', type: 'user' },
        { id: 'added', name: 'Added', type: 'user' }
      ],
      removeIds: ['deleted']
    })
  })

  it('replaces the catalog atomically, reports real changes, and leaves memberships alone', () => {
    const db = openDatabase(':memory:')
    try {
      expect(
        upsertLabels(db, 'account', [
          { id: 'renamed', name: 'Old name', type: 'user' },
          { id: 'deleted', name: 'Deleted', type: 'user' }
        ])
      ).toBe(true)
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES ('account', 'thread', 'deleted')`
      ).run()

      const authoritative = [
        { id: 'renamed', name: 'New name', type: 'user' },
        { id: 'added', name: 'Added', type: 'user' }
      ]
      expect(upsertLabels(db, 'account', authoritative)).toBe(true)
      expect(
        db.prepare('SELECT id, name, type FROM labels WHERE account_id = ? ORDER BY id').all('account')
      ).toEqual([
        { id: 'added', name: 'Added', type: 'user' },
        { id: 'renamed', name: 'New name', type: 'user' }
      ])
      expect(db.prepare('SELECT label_id FROM thread_labels WHERE account_id = ?').all('account')).toEqual([
        { label_id: 'deleted' }
      ])
      expect(upsertLabels(db, 'account', authoritative)).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('thread snapshot persistence', () => {
  it('excludes Gmail draft and legacy Chat messages from the ordinary conversation snapshot', () => {
    const real = { id: 'sent', threadId: 'thread', labelIds: ['SENT'], snippet: 'Sent copy' }
    const draft = { id: 'draft', threadId: 'thread', labelIds: ['DRAFT'], snippet: 'Unsent copy' }
    const chat = { id: 'chat', threadId: 'thread', labelIds: ['CHAT'], snippet: 'Legacy chat' }
    expect(nonDraftMessages([real, draft, chat])).toEqual([real])
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

    // The production path: an authoritative snapshot holding m2/m3 must remove
    // any other stored message of the thread and rebuild its contacts.
    persistThread(db, 'account', {
      id: 'thread',
      messages: [
        { id: 'm2', threadId: 'thread', labelIds: ['INBOX'] },
        { id: 'm3', threadId: 'thread', labelIds: ['INBOX'] }
      ]
    })

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
