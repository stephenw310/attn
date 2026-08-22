import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '.'
import {
  getConversation,
  getConversationForDisplay,
  listInboxThreads,
  listMailboxThreadIds,
  listSnoozedThreads
} from './queries'

describe('thread list queries', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'account',
      'test@example.com',
      0
    )
    const insertThread = db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, last_msg_at, from_display, is_unread, is_starred, has_attachment)
       VALUES ('account', ?, ?, ?, ?, ?, ?, ?)`
    )
    insertThread.run('newest', 'Newest', 300, 'Maya', 1, 1, 1)
    insertThread.run('older', 'Older', 200, 'Theo', 0, 0, 0)
    insertThread.run('snoozed', 'Snoozed', 100, 'Priya', 0, 0, 0)

    const insertLabel = db.prepare(
      'INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
    )
    insertLabel.run('account', 'newest', 'INBOX')
    insertLabel.run('account', 'newest', 'Label_2')
    insertLabel.run('account', 'older', 'INBOX')
    insertLabel.run('account', 'snoozed', 'Label_A')

    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES ('account', 'newest', 'snooze', 0, 'returned')`
    ).run()
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES ('account', 'snoozed', 'snooze', 100, 'pending')`
    ).run()
    db.prepare(
      `INSERT INTO outbox (id, account_id, state, thread_id, created_at, updated_at)
       VALUES ('draft', 'account', 'drafted', 'newest', 0, 0)`
    ).run()
  })

  afterEach(() => db.close())

  it('returns bounded inbox rows with flags and labels in one static query', () => {
    expect(listInboxThreads(db, 'account', 1)).toEqual([
      expect.objectContaining({
        id: 'newest',
        subject: 'Newest',
        unread: true,
        starred: true,
        hasAttachment: true,
        returned: true,
        hasDraft: true,
        labelIds: ['INBOX', 'Label_2']
      })
    ])
    expect(listInboxThreads(db, 'account').map((thread) => thread.id)).toEqual(['newest', 'older'])
  })

  it('returns pending snoozes with their labels', () => {
    expect(listSnoozedThreads(db, 'account')).toEqual([
      expect.objectContaining({
        id: 'snoozed',
        dueAt: 100,
        returned: false,
        labelIds: ['Label_A']
      })
    ])
  })

  it('uses per-message truth for All Mail, Spam, and Trash membership', () => {
    const insertThread = db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at)
       VALUES ('account', ?, ?, ?)`
    )
    const insertMessage = db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       VALUES ('account', ?, ?, ?, ?)`
    )
    insertThread.run('mixed', 'Mixed', 500)
    insertMessage.run('mixed-live', 'mixed', 500, '["INBOX"]')
    insertMessage.run('mixed-trash', 'mixed', 300, '["TRASH"]')
    insertThread.run('only-trash', 'Only trash', 400)
    insertMessage.run('only-trash-message', 'only-trash', 400, '["TRASH"]')
    insertThread.run('only-spam', 'Only spam', 350)
    insertMessage.run('only-spam-message', 'only-spam', 350, '["SPAM"]')
    insertThread.run('legacy-trash', 'Legacy trash', 325)
    insertMessage.run('legacy-trash-message', 'legacy-trash', 325, null)
    const insertThreadLabel = db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('account', ?, ?)`
    )
    insertThreadLabel.run('mixed', 'INBOX')
    insertThreadLabel.run('mixed', 'TRASH')
    insertThreadLabel.run('only-trash', 'TRASH')
    insertThreadLabel.run('only-spam', 'SPAM')
    insertThreadLabel.run('legacy-trash', 'TRASH')

    expect(listMailboxThreadIds(db, 'account', 'all-mail')).toEqual(['mixed'])
    expect(listMailboxThreadIds(db, 'account', 'trash')).toEqual(['only-trash', 'legacy-trash', 'mixed'])
    expect(listMailboxThreadIds(db, 'account', 'spam')).toEqual(['only-spam'])
  })

  it('keeps All Mail scoped to its account when another account needs the slow path', () => {
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'other-account',
      'other@example.com',
      0
    )
    db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at)
       VALUES ('other-account', 'other-mixed', 'Other account', 1000)`
    ).run()
    const insertMessage = db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       VALUES ('other-account', ?, 'other-mixed', ?, ?)`
    )
    insertMessage.run('other-live', 1000, '["INBOX"]')
    insertMessage.run('other-trash', 900, '["TRASH"]')
    const insertThreadLabel = db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('other-account', 'other-mixed', ?)`
    )
    insertThreadLabel.run('INBOX')
    insertThreadLabel.run('TRASH')

    expect(listMailboxThreadIds(db, 'account', 'all-mail')).not.toContain('other-mixed')
    expect(listMailboxThreadIds(db, 'other-account', 'all-mail')).toEqual(['other-mixed'])
  })

  it('uses SQLite indexes for sparse Spam and Trash membership', () => {
    const explain = (mailbox: 'spam' | 'trash'): string[] => {
      let details: string[] = []
      const queryDb = {
        prepare: (sql: string) => {
          const statement = db.prepare(sql)
          return {
            all: (...params: unknown[]) => {
              details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
                (row) => row.detail
              )
              return statement.all(...params)
            }
          }
        }
      } as unknown as Db

      listMailboxThreadIds(queryDb, 'account', mailbox)
      return details
    }

    for (const mailbox of ['spam', 'trash'] as const) {
      const details = explain(mailbox)
      expect(details.some((detail) => detail.includes('idx_thread_labels_label'))).toBe(true)
      expect(details.some((detail) => detail.includes('idx_messages_thread'))).toBe(true)
    }
  })
})

describe('display conversation queries', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'account',
      'test@example.com',
      0
    )
    db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at)
       VALUES ('account', 'thread-1', 'Roadmap', 100)`
    ).run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_name, from_email, internal_date, body_text,
        recipients_json, attachments_json, rfc_message_id, references_json)
       VALUES ('account', 'message-1', 'thread-1', 'Maya', 'maya@example.com', 100, 'Initial',
               '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]', '<initial@example.com>', '[]')`
    ).run()
    db.prepare(
      `INSERT INTO outbox
       (id, account_id, state, kind, to_json, cc_json, bcc_json, body_html, body_text,
        attachments_json, thread_id, references_json, quote_html, quote_text, created_at,
        updated_at, rfc_message_id)
       VALUES ('reply-1', 'account', 'queued', 'reply',
               '[{"name":"Maya","email":"maya@example.com"}]', '[]', '[]',
               '<p>Queued reply</p>', 'Queued reply',
               '[{"id":"attachment-1","filename":"notes.txt","mimeType":"text/plain","sizeBytes":12}]',
               'thread-1', '["<initial@example.com>"]', '<blockquote>Initial</blockquote>',
               '> Initial', 150, 200, '<reply@example.com>')`
    ).run()
  })

  afterEach(() => db.close())

  it('projects queued replies immediately and removes them when undo returns to composing', () => {
    const queued = getConversationForDisplay(db, 'account', 'thread-1', 'unavailable')
    expect(queued?.messages).toHaveLength(2)
    expect(queued?.messages.at(-1)).toMatchObject({
      id: 'outbox:reply-1',
      pending: true,
      fromName: 'Me',
      fromEmail: 'test@example.com',
      bodyText: 'Queued reply\n\n> Initial',
      bodyHtml: '<p>Queued reply</p>\n<blockquote>Initial</blockquote>',
      recipients: {
        to: [{ name: 'Maya', email: 'maya@example.com' }],
        cc: [],
        bcc: [],
        replyTo: []
      },
      attachments: [
        {
          attachmentId: 'attachment-1',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 12
        }
      ]
    })

    db.prepare("UPDATE outbox SET state = 'composing' WHERE id = 'reply-1'").run()
    expect(getConversationForDisplay(db, 'account', 'thread-1', 'unavailable')?.messages).toHaveLength(1)
  })

  it('replaces the local projection when the confirmed Gmail message arrives', () => {
    db.prepare("UPDATE outbox SET state = 'sent', gmail_message_id = 'message-2' WHERE id = 'reply-1'").run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_name, from_email, internal_date, body_text,
        recipients_json, attachments_json, rfc_message_id, references_json)
       VALUES ('account', 'message-2', 'thread-1', '', 'test@example.com', 250, 'Queued reply',
               '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]', '<reply@example.com>',
               '["<initial@example.com>"]')`
    ).run()

    const confirmed = getConversationForDisplay(db, 'account', 'thread-1', 'unavailable')
    expect(confirmed?.messages.map((message) => message.id)).toEqual(['message-1', 'message-2'])
    expect(confirmed?.messages.some((message) => message.pending)).toBe(false)
  })

  it('heals a stale draft message id without appending the old projection after newer mail', () => {
    db.prepare(
      "UPDATE outbox SET state = 'sent', gmail_message_id = 'stale-draft-message' WHERE id = 'reply-1'"
    ).run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_name, from_email, internal_date, body_text,
        recipients_json, attachments_json, rfc_message_id, references_json)
       VALUES ('account', 'message-legacy', 'thread-1', '', 'test@example.com', 250,
               'Queued reply\n\n> Initial',
               '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]', '<gmail-rewritten@example.com>',
               '["<initial@example.com>"]')`
    ).run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_name, from_email, internal_date, body_text,
        recipients_json, attachments_json, rfc_message_id, references_json)
       VALUES ('account', 'message-later', 'thread-1', 'Maya', 'maya@example.com', 300,
               'A later reply', '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]',
               '<later@example.com>', '["<gmail-rewritten@example.com>"]')`
    ).run()

    const confirmed = getConversationForDisplay(db, 'account', 'thread-1', 'unavailable')
    expect(confirmed?.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-legacy',
      'message-later'
    ])
    expect(confirmed?.messages.some((message) => message.pending)).toBe(false)
  })

  it('renders the message subset that belongs to the active mailbox', () => {
    const insert = db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, internal_date, body_text, labels_json)
       VALUES ('account', ?, 'thread-1', ?, ?, ?)`
    )
    db.prepare("UPDATE messages SET labels_json = '[\"INBOX\"]' WHERE id = 'message-1'").run()
    insert.run('message-trash', 110, 'Deleted copy', '["TRASH"]')
    insert.run('message-spam', 120, 'Spam copy', '["SPAM"]')
    insert.run('message-draft', 130, 'Unsent copy', '["DRAFT"]')

    const ids = (mailbox: 'normal' | 'all-mail' | 'spam' | 'trash'): string[] =>
      getConversation(db, 'account', 'thread-1', 'unavailable', mailbox)?.messages.map(
        (message) => message.id
      ) ?? []
    expect(ids('normal')).toEqual(['message-1'])
    expect(ids('all-mail')).toEqual(['message-1'])
    expect(ids('trash')).toEqual(['message-trash'])
    expect(ids('spam')).toEqual(['message-spam'])
    expect(
      getConversationForDisplay(db, 'account', 'thread-1', 'unavailable', 'trash')?.messages.map(
        (message) => message.id
      )
    ).toEqual(['message-trash'])
  })

  it('keeps legacy mixed-label messages readable until an authoritative refetch', () => {
    db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('account', 'thread-1', 'INBOX'), ('account', 'thread-1', 'TRASH')`
    ).run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, internal_date, body_text, labels_json)
       VALUES ('account', 'message-legacy-2', 'thread-1', 110, 'Second legacy message', NULL)`
    ).run()

    const ids = (mailbox: 'normal' | 'all-mail' | 'trash'): string[] =>
      getConversation(db, 'account', 'thread-1', 'unavailable', mailbox)?.messages.map(
        (message) => message.id
      ) ?? []
    expect(ids('normal')).toEqual(['message-1', 'message-legacy-2'])
    expect(ids('all-mail')).toEqual(['message-1', 'message-legacy-2'])
    expect(ids('trash')).toEqual(['message-1', 'message-legacy-2'])
  })
})
