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

  it('stores message labels from full and metadata snapshots without losing attachments', () => {
    const db = openDatabase(':memory:')
    try {
      const message = {
        id: 'message',
        threadId: 'thread',
        labelIds: ['INBOX', 'TRASH'],
        internalDate: '100',
        snippet: 'Full snapshot',
        payload: {
          headers: [
            { name: 'From', value: 'Maya <maya@example.com>' },
            { name: 'Subject', value: 'Roadmap' }
          ],
          parts: [
            {
              mimeType: 'application/pdf',
              filename: 'notes.pdf',
              body: { attachmentId: 'attachment', size: 42 }
            }
          ]
        }
      }
      persistThread(db, 'account', { id: 'thread', messages: [message] })
      const full = db
        .prepare('SELECT labels_json, attachments_json FROM messages WHERE account_id = ? AND id = ?')
        .get('account', 'message') as { labels_json: string; attachments_json: string }
      expect(JSON.parse(full.labels_json)).toEqual(['INBOX', 'TRASH'])
      expect(JSON.parse(full.attachments_json)).toEqual([
        expect.objectContaining({ attachmentId: 'attachment', filename: 'notes.pdf', sizeBytes: 42 })
      ])

      persistThread(
        db,
        'account',
        {
          id: 'thread',
          messages: [
            {
              ...message,
              labelIds: ['INBOX', 'STARRED'],
              snippet: 'Metadata snapshot',
              payload: { headers: message.payload.headers }
            }
          ]
        },
        { metadataOnly: true }
      )
      const metadata = db
        .prepare('SELECT labels_json, attachments_json FROM messages WHERE account_id = ? AND id = ?')
        .get('account', 'message') as { labels_json: string; attachments_json: string }
      expect(JSON.parse(metadata.labels_json)).toEqual(['INBOX', 'STARRED'])
      expect(metadata.attachments_json).toBe(full.attachments_json)
    } finally {
      db.close()
    }
  })

  it('summarizes the messages shown by the normal reader instead of newer junk', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', {
        id: 'thread',
        messages: [
          {
            id: 'visible',
            threadId: 'thread',
            labelIds: ['INBOX'],
            internalDate: '200',
            snippet: 'Visible reply',
            payload: {
              headers: [
                { name: 'From', value: 'Maya <maya@example.com>' },
                { name: 'Subject', value: 'Roadmap' }
              ]
            }
          },
          {
            id: 'trashed',
            threadId: 'thread',
            labelIds: ['TRASH', 'UNREAD', 'STARRED'],
            internalDate: '300',
            snippet: 'Hidden deleted reply',
            payload: {
              headers: [
                { name: 'From', value: 'Deleted <deleted@example.com>' },
                { name: 'Subject', value: 'Roadmap' }
              ],
              parts: [
                {
                  mimeType: 'application/pdf',
                  filename: 'deleted.pdf',
                  body: { attachmentId: 'deleted-attachment', size: 42 }
                }
              ]
            }
          }
        ]
      })

      expect(
        db
          .prepare(
            `SELECT subject, snippet, last_msg_at, from_display, is_unread, is_starred, has_attachment
             FROM threads WHERE account_id = ? AND id = ?`
          )
          .get('account', 'thread')
      ).toEqual({
        subject: 'Roadmap',
        snippet: 'Visible reply',
        last_msg_at: 200,
        from_display: 'Maya',
        is_unread: 0,
        is_starred: 0,
        has_attachment: 0
      })
    } finally {
      db.close()
    }
  })

  it('summarizes a self-authored latest message as Me', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'me@example.com', {
        id: 'thread',
        messages: [
          {
            id: 'sent',
            threadId: 'thread',
            labelIds: ['SENT'],
            internalDate: '200',
            snippet: 'Sent reply',
            payload: {
              headers: [
                { name: 'From', value: 'magic-name <me@example.com>' },
                { name: 'Subject', value: 'Roadmap' }
              ]
            }
          }
        ]
      })

      expect(
        db
          .prepare('SELECT from_display FROM threads WHERE account_id = ? AND id = ?')
          .get('me@example.com', 'thread')
      ).toEqual({ from_display: 'Me' })
    } finally {
      db.close()
    }
  })

  it('keeps a useful summary when every stored message is junk', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', {
        id: 'thread',
        messages: [
          {
            id: 'trashed',
            threadId: 'thread',
            labelIds: ['TRASH', 'UNREAD'],
            internalDate: '300',
            snippet: 'Deleted reply',
            payload: {
              headers: [
                { name: 'From', value: 'Maya <maya@example.com>' },
                { name: 'Subject', value: 'Roadmap' }
              ]
            }
          }
        ]
      })

      expect(
        db
          .prepare(
            `SELECT subject, snippet, last_msg_at, from_display, is_unread
             FROM threads WHERE account_id = ? AND id = ?`
          )
          .get('account', 'thread')
      ).toEqual({
        subject: 'Roadmap',
        snippet: 'Deleted reply',
        last_msg_at: 300,
        from_display: 'Maya',
        is_unread: 1
      })
    } finally {
      db.close()
    }
  })

  it('prunes stale ordinary mail when the authoritative snapshot contains only a draft', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', {
        id: 'thread',
        messages: [
          {
            id: 'sent',
            threadId: 'thread',
            labelIds: ['INBOX'],
            internalDate: '100',
            payload: {
              headers: [
                { name: 'From', value: 'Maya <maya@example.com>' },
                { name: 'Subject', value: 'Roadmap' }
              ]
            }
          }
        ]
      })

      expect(
        persistThread(db, 'account', {
          id: 'thread',
          messages: [{ id: 'draft', threadId: 'thread', labelIds: ['DRAFT'] }]
        })
      ).toBe(false)
      expect(db.prepare('SELECT id FROM threads WHERE account_id = ?').all('account')).toEqual([])
      expect(db.prepare('SELECT id FROM messages WHERE account_id = ?').all('account')).toEqual([])
      expect(db.prepare('SELECT email FROM contacts WHERE account_id = ?').all('account')).toEqual([])
    } finally {
      db.close()
    }
  })
})
