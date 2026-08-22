import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '.'
import { getConversationForDisplay, listInboxThreads, listSnoozedThreads } from './queries'

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

  it('heals sent projections created before Gmail message ids were retained', () => {
    db.prepare("UPDATE outbox SET state = 'sent' WHERE id = 'reply-1'").run()
    db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_name, from_email, internal_date, body_text,
        recipients_json, attachments_json, rfc_message_id, references_json)
       VALUES ('account', 'message-legacy', 'thread-1', '', 'test@example.com', 250,
               'Queued reply\n\n> Initial',
               '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]', '<gmail-rewritten@example.com>',
               '["<initial@example.com>"]')`
    ).run()

    const confirmed = getConversationForDisplay(db, 'account', 'thread-1', 'unavailable')
    expect(confirmed?.messages.map((message) => message.id)).toEqual(['message-1', 'message-legacy'])
    expect(confirmed?.messages.some((message) => message.pending)).toBe(false)
  })
})
