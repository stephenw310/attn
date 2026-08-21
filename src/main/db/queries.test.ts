import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '.'
import { listInboxThreads, listSnoozedThreads } from './queries'

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
