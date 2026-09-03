import { describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import {
  ensureAccount,
  nonDraftMessages,
  persistThread,
  planLabelCatalogUpdate,
  upsertLabels
} from './persist'

const ACCOUNT = 'persist@example.test'

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
            { name: 'Subject', value: 'Roadmap' },
            { name: 'List-Id', value: 'Roadmap updates <Roadmap.Example.COM>' }
          ],
          parts: [
            {
              mimeType: 'application/pdf',
              filename: 'notes.pdf',
              body: { attachmentId: 'attachment', size: 42 }
            },
            {
              mimeType: 'text/calendar',
              body: { attachmentId: 'calendar-body', size: 120 }
            }
          ]
        }
      }
      persistThread(db, 'account', { id: 'thread', messages: [message] })
      const full = db
        .prepare(
          `SELECT labels_json, attachments_json, list_id, has_calendar_part
           FROM messages WHERE account_id = ? AND id = ?`
        )
        .get('account', 'message') as {
        labels_json: string
        attachments_json: string
        list_id: string | null
        has_calendar_part: number
      }
      expect(JSON.parse(full.labels_json)).toEqual(['INBOX', 'TRASH'])
      expect(JSON.parse(full.attachments_json)).toEqual([
        expect.objectContaining({ attachmentId: 'attachment', filename: 'notes.pdf', sizeBytes: 42 })
      ])
      expect(full.list_id).toBe('<roadmap.example.com>')
      expect(full.has_calendar_part).toBe(1)

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
              payload: {
                headers: message.payload.headers.map((header) =>
                  header.name === 'List-Id'
                    ? { name: 'List-Id', value: 'Renamed <renamed.example.com>' }
                    : header
                )
              }
            }
          ]
        },
        { metadataOnly: true }
      )
      const metadata = db
        .prepare(
          `SELECT labels_json, attachments_json, list_id, has_calendar_part
           FROM messages WHERE account_id = ? AND id = ?`
        )
        .get('account', 'message') as {
        labels_json: string
        attachments_json: string
        list_id: string | null
        has_calendar_part: number
      }
      expect(JSON.parse(metadata.labels_json)).toEqual(['INBOX', 'STARRED'])
      expect(metadata.attachments_json).toBe(full.attachments_json)
      expect(metadata.list_id).toBe('<renamed.example.com>')
      expect(metadata.has_calendar_part).toBe(1)
    } finally {
      db.close()
    }
  })

  it('replays pending local intent inside the snapshot transaction', () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, 'account', 'account')
      db.prepare(
        `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
         VALUES ('account', 'modifyLabels', 'thread', '{"add":[],"remove":["INBOX"]}', 'pending')`
      ).run()

      // A crash between the snapshot and the replay would leave Gmail's label
      // set visible — the archived thread back in the Inbox — so both must
      // commit together. The nested transaction becomes a savepoint.
      const prepared: { sql: string; inTransaction: boolean }[] = []
      const tracked = {
        prepare: (sql: string) => {
          prepared.push({ sql, inTransaction: db.inTransaction })
          return db.prepare(sql)
        },
        transaction: (callback: () => void) => db.transaction(callback)
      } as unknown as Db

      persistThread(tracked, 'account', {
        id: 'thread',
        messages: [{ id: 'message', threadId: 'thread', labelIds: ['INBOX'], internalDate: '100' }]
      })

      const replayReads = prepared.filter(
        (statement) => statement.sql.includes('FROM action_queue') || statement.sql.includes('FROM reminders')
      )
      expect(replayReads.length).toBeGreaterThan(0)
      expect(replayReads.every((statement) => statement.inTransaction)).toBe(true)
      // The pending archive still wins over the authoritative snapshot.
      expect(db.prepare('SELECT label_id FROM thread_labels').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps a new row out of the bounded Inbox surface unless the caller promotes it', () => {
    const db = openDatabase(':memory:')
    try {
      const message = (threadId: string): { id: string; threadId: string; labelIds: string[] } => ({
        id: `message-${threadId}`,
        threadId,
        labelIds: ['INBOX']
      })
      const visibility = (threadId: string): { is_inbox_visible: number } =>
        db
          .prepare('SELECT is_inbox_visible FROM threads WHERE account_id = ? AND id = ?')
          .get('account', threadId) as { is_inbox_visible: number }

      // A label-only poller refetch and a server-search store both pass
      // 'preserve': neither may pull an older thread into the Inbox surface.
      persistThread(
        db,
        'account',
        { id: 'preserved', messages: [message('preserved')] },
        {
          inboxVisibility: 'preserve'
        }
      )
      persistThread(
        db,
        'account',
        { id: 'hidden', messages: [message('hidden')] },
        {
          inboxVisibility: 'hide'
        }
      )
      persistThread(
        db,
        'account',
        { id: 'promoted', messages: [message('promoted')] },
        {
          inboxVisibility: 'show'
        }
      )
      persistThread(db, 'account', { id: 'default', messages: [message('default')] })

      expect(visibility('preserved')).toEqual({ is_inbox_visible: 0 })
      expect(visibility('hidden')).toEqual({ is_inbox_visible: 0 })
      expect(visibility('promoted')).toEqual({ is_inbox_visible: 1 })
      expect(visibility('default')).toEqual({ is_inbox_visible: 1 })

      // A later Inbox event promotes the stored row; an ordinary refetch keeps
      // whichever choice the row already carries.
      persistThread(
        db,
        'account',
        { id: 'preserved', messages: [message('preserved')] },
        {
          inboxVisibility: 'show'
        }
      )
      persistThread(
        db,
        'account',
        { id: 'promoted', messages: [message('promoted')] },
        {
          inboxVisibility: 'preserve'
        }
      )
      expect(visibility('preserved')).toEqual({ is_inbox_visible: 1 })
      expect(visibility('promoted')).toEqual({ is_inbox_visible: 1 })
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

describe('storing a thread stays proportional to the thread', () => {
  it('drives the removed-contact lookup from the thread, not the account', () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const plans: string[][] = []
      const explainingDb = {
        prepare: (sql: string) => {
          const statement = db.prepare(sql)
          return {
            all: (...params: unknown[]) => {
              if (sql.includes('contact_messages cm')) {
                plans.push(
                  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
                    (row) => row.detail
                  )
                )
              }
              return statement.all(...params)
            },
            run: (...params: unknown[]) => statement.run(...params),
            get: (...params: unknown[]) => statement.get(...params)
          }
        },
        transaction: (fn: () => void) => db.transaction(fn),
        pragma: (source: string) => db.pragma(source)
      } as unknown as typeof db

      persistThread(explainingDb, ACCOUNT, {
        id: 't-plan',
        messages: [
          {
            id: 'm-plan',
            threadId: 't-plan',
            labelIds: ['INBOX'],
            internalDate: '1000',
            snippet: 'plan',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Sender <sender@example.test>' },
                { name: 'To', value: ACCOUNT },
                { name: 'Subject', value: 'Plan' }
              ],
              body: { data: Buffer.from('plan').toString('base64url') }
            }
          }
        ]
      })

      expect(plans).toHaveLength(1)
      // Scanning the account's contact rows here made every write cost more as
      // the store grew: importing 20,000 threads fell from 2,000/s to 84/s.
      const [first, second] = plans[0]
      expect(first, plans[0].join(' | ')).toContain('messages')
      expect(first).not.toContain('contact_messages')
      expect(second, plans[0].join(' | ')).toContain('contact_messages')
      expect(second).toContain('message_id=?')
    } finally {
      db.close()
    }
  })
})
