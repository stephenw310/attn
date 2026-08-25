import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '.'
import {
  countSystemMailboxes,
  getConversation,
  getConversationForDisplay,
  type LabelMailboxView,
  listInboxThreads,
  listLabelThreads,
  listMailboxThreads,
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

  it('continues inbox pages after a timestamp and thread-id cursor', () => {
    db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, last_msg_at, from_display, is_unread, is_starred, has_attachment)
       VALUES ('account', 'newest-z', 'Newest tie', 300, 'Zoe', 0, 0, 0)`
    ).run()
    db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('account', 'newest-z', 'INBOX')`
    ).run()

    expect(listInboxThreads(db, 'account', 1).map((thread) => thread.id)).toEqual(['newest'])
    expect(listInboxThreads(db, 'account', 1, { at: 300, id: 'newest' }).map((thread) => thread.id)).toEqual([
      'newest-z'
    ])
    expect(
      listInboxThreads(db, 'account', 1, { at: 300, id: 'newest-z' }).map((thread) => thread.id)
    ).toEqual(['older'])
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

  it('counts every system mailbox from the same local membership rules as its list', () => {
    expect(countSystemMailboxes(db, 'account')).toEqual({
      inbox: 2,
      allMail: 0,
      sent: 0,
      starred: 0,
      snoozed: 1,
      spam: 0,
      trash: 0
    })
  })

  it('continues ascending snoozed pages after equal due dates', () => {
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES ('account', 'older', 'snooze', 100, 'pending')`
    ).run()

    expect(listSnoozedThreads(db, 'account', 1).map((thread) => thread.id)).toEqual(['older'])
    expect(listSnoozedThreads(db, 'account', 1, { at: 100, id: 'older' }).map((thread) => thread.id)).toEqual(
      ['snoozed']
    )
  })

  const mailboxIds = (view: LabelMailboxView): string[] =>
    listMailboxThreads(db, 'account', view).map((row) => row.id)

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

    expect(mailboxIds('allMail')).toEqual(['mixed'])
    // Trash sorts by the mailbox's newest matching message: mixed's only
    // trashed message (300) files behind both fully trashed threads.
    expect(mailboxIds('trash')).toEqual(['only-trash', 'legacy-trash', 'mixed'])
    expect(mailboxIds('spam')).toEqual(['only-spam'])
    expect(countSystemMailboxes(db, 'account')).toMatchObject({ allMail: 1, spam: 1, trash: 3 })
    expect(listMailboxThreads(db, 'account', 'trash').map((row) => [row.id, row.lastMsgAt])).toEqual([
      ['only-trash', 400],
      ['legacy-trash', 325],
      ['mixed', 300]
    ])
  })

  it('applies the normal junk exclusion to Sent and Starred membership', () => {
    const insertThread = db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at)
       VALUES ('account', ?, ?, ?)`
    )
    const insertMessage = db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       VALUES ('account', ?, ?, ?, ?)`
    )
    const insertThreadLabel = db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('account', ?, ?)`
    )
    insertThread.run('sent-live', 'Sent live', 500)
    insertMessage.run('sent-live-message', 'sent-live', 500, '["SENT"]')
    insertThreadLabel.run('sent-live', 'SENT')
    // The thread label union still carries SENT, but its only sent copy was
    // trashed: it belongs to Trash now, not Sent.
    insertThread.run('sent-trashed', 'Sent then trashed', 450)
    insertMessage.run('sent-trashed-message', 'sent-trashed', 450, '["SENT","TRASH"]')
    insertMessage.run('sent-trashed-reply', 'sent-trashed', 440, '["INBOX"]')
    insertThreadLabel.run('sent-trashed', 'SENT')
    insertThreadLabel.run('sent-trashed', 'TRASH')
    insertThreadLabel.run('sent-trashed', 'INBOX')
    // A Gmail draft never renders as sent mail (SPEC F3).
    insertThread.run('sent-draft', 'Draft only', 430)
    insertMessage.run('sent-draft-message', 'sent-draft', 430, '["SENT","DRAFT"]')
    insertThreadLabel.run('sent-draft', 'SENT')
    insertThreadLabel.run('sent-draft', 'DRAFT')
    // Legacy rows without labels_json fall back to thread-level labels.
    insertThread.run('sent-legacy', 'Sent legacy', 420)
    insertMessage.run('sent-legacy-message', 'sent-legacy', 420, null)
    insertThreadLabel.run('sent-legacy', 'SENT')
    insertThread.run('starred-live', 'Starred live', 410)
    insertMessage.run('starred-live-message', 'starred-live', 410, '["INBOX","STARRED"]')
    insertThreadLabel.run('starred-live', 'STARRED')
    insertThread.run('starred-spammed', 'Starred spammed', 400)
    insertMessage.run('starred-spammed-message', 'starred-spammed', 400, '["STARRED","SPAM"]')
    insertThreadLabel.run('starred-spammed', 'STARRED')
    insertThreadLabel.run('starred-spammed', 'SPAM')

    expect(mailboxIds('sent')).toEqual(['sent-live', 'sent-legacy'])
    expect(mailboxIds('starred')).toEqual(['starred-live'])
    expect(countSystemMailboxes(db, 'account')).toMatchObject({ sent: 2, starred: 1 })
  })

  it('lists a user label from local message membership and excludes junk copies', () => {
    db.prepare(
      `INSERT INTO labels (account_id, id, name, type)
       VALUES ('account', 'Label_2', 'projects', 'user')`
    ).run()
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       VALUES ('account', 'newest-message', 'newest', 300, '["INBOX","Label_2"]')`
    ).run()

    db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at)
       VALUES ('account', 'junk-project', 'Junk project', 400)`
    ).run()
    for (const labelId of ['Label_2', 'SPAM']) {
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES ('account', 'junk-project', ?)`
      ).run(labelId)
    }
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       VALUES ('account', 'junk-project-message', 'junk-project', 400, '["Label_2","SPAM"]')`
    ).run()

    expect(listLabelThreads(db, 'account', 'Label_2').map((row) => row.id)).toEqual(['newest'])
    expect(listLabelThreads(db, 'account', 'Label_missing')).toEqual([])
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

    expect(mailboxIds('allMail')).not.toContain('other-mixed')
    expect(listMailboxThreads(db, 'other-account', 'allMail').map((row) => row.id)).toEqual(['other-mixed'])
  })

  it('uses SQLite indexes for sparse label-driven mailbox membership', () => {
    const explain = (mailbox: LabelMailboxView): string[] => {
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

      listMailboxThreads(queryDb, 'account', mailbox)
      return details
    }

    for (const mailbox of ['spam', 'trash', 'sent', 'starred'] as const) {
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
    expect(confirmed?.messages.at(-1)).toMatchObject({
      fromName: 'Me',
      fromEmail: 'test@example.com'
    })
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

  it('keeps trashed messages at their chronological position as reader markers', () => {
    const insert = db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, internal_date, body_text, labels_json)
       VALUES ('account', ?, 'thread-1', ?, ?, ?)`
    )
    db.prepare("UPDATE messages SET labels_json = '[\"INBOX\"]' WHERE id = 'message-1'").run()
    insert.run('message-trash', 110, 'Deleted middle copy', '["TRASH"]')
    insert.run('message-late', 120, 'Later reply', '["INBOX"]')
    insert.run('message-spam', 130, 'Spam copy', '["SPAM"]')
    insert.run('message-spam-trash', 140, 'Spammed then trashed', '["SPAM","TRASH"]')

    const marked = getConversation(db, 'account', 'thread-1', 'unavailable', 'normal', true)
    expect(marked?.messages.map((message) => [message.id, message.trashed === true])).toEqual([
      ['message-1', false],
      ['message-trash', true],
      ['message-late', false]
    ])
    // All Mail readers carry the same markers; spammed messages stay hidden.
    expect(
      getConversation(db, 'account', 'thread-1', 'unavailable', 'all-mail', true)?.messages.map(
        (message) => message.id
      )
    ).toEqual(['message-1', 'message-trash', 'message-late'])
    // Reply planning and other non-display readers keep the filtered projection.
    expect(
      getConversation(db, 'account', 'thread-1', 'unavailable')?.messages.map((message) => message.id)
    ).toEqual(['message-1', 'message-late'])
    // The Trash reader shows trashed messages as ordinary cards, never markers.
    expect(
      getConversationForDisplay(db, 'account', 'thread-1', 'unavailable', 'trash', true)?.messages.map(
        (message) => [message.id, message.trashed === true]
      )
    ).toEqual([
      ['message-trash', false],
      ['message-spam-trash', false]
    ])
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
