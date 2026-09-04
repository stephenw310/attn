import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSplitSetup } from '../splits'
import { type Db, openDatabase } from '.'
import {
  MATERIALIZED_MAILBOX_VIEWS,
  type MaterializedMailboxView,
  refreshThreadMailboxes,
  runMailboxMembershipBackfill
} from './mailboxMembership'
import {
  allMailMembershipSql,
  countSystemMailboxes,
  getConversation,
  getConversationForDisplay,
  type LabelMailboxView,
  labeledMailboxMembershipSql,
  listInboxThreads,
  listLabelThreads,
  listMailboxThreads,
  listSnoozedThreads
} from './queries'

/**
 * Derived membership is maintained by `persistThread` and `applyThreadDelta`. A
 * test that writes rows directly is standing in for a profile that predates the
 * table, so it fills them the way the backfill does.
 */
function fillMembership(db: Db, accountId = 'account'): void {
  for (const row of db.prepare('SELECT id FROM threads WHERE account_id = ?').all(accountId) as {
    id: string
  }[]) {
    refreshThreadMailboxes(db, accountId, row.id)
  }
}

describe('thread list queries', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('account', 'test@example.com')
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
    fillMembership(db)
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

  it('pages the returned follow-up tier by its own keyset before the dated flow', () => {
    // Three returned follow-ups, two tied on due_at, on top of the fixture's
    // two dated inbox threads. The tier must page out completely — including
    // across a boundary inside it — before the dated flow starts from its
    // beginning (PR #101 review: the prepend-once shape lost the overflow).
    const insertThread = db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, last_msg_at, from_display, is_unread, is_starred, has_attachment)
       VALUES ('account', ?, ?, ?, 'Ana', 0, 0, 0)`
    )
    const insertLabel = db.prepare(
      "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('account', ?, 'INBOX')"
    )
    const insertReminder = db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES ('account', ?, 'follow_up', ?, 'returned')`
    )
    for (const [id, dueAt] of [
      ['follow-a', 900],
      ['follow-b', 500],
      ['follow-c', 500]
    ] as const) {
      insertThread.run(id, id, 250)
      insertLabel.run(id)
      insertReminder.run(id, dueAt)
    }

    const first = listInboxThreads(db, 'account', 2)
    expect(first.map((thread) => thread.id)).toEqual(['follow-a', 'follow-b'])
    expect(first.map((thread) => thread.followUpTierAt)).toEqual([900, 500])

    // A boundary inside the tier continues by (due_at, id) — the tie between
    // follow-b and follow-c must not skip or repeat a row — and the tier
    // hands over to the dated flow inside the same page.
    const second = listInboxThreads(db, 'account', 2, { at: 500, id: 'follow-b', tier: 'followUp' })
    expect(second.map((thread) => thread.id)).toEqual(['follow-c', 'newest'])
    expect(second[0].followUpTierAt).toBe(500)
    expect(second[1].followUpTierAt).toBeUndefined()

    // The dated flow then pages normally, still excluding every tier thread.
    expect(listInboxThreads(db, 'account', 2, { at: 300, id: 'newest' }).map((thread) => thread.id)).toEqual([
      'older'
    ])
  })

  it.each([undefined, 'fallback:other'])(
    'pages across positive, null, zero, and negative dates in %s',
    (splitId) => {
      if (splitId) ensureSplitSetup(db, 'account')
      const insertThread = db.prepare(
        "INSERT INTO threads (account_id, id, last_msg_at) VALUES ('account', ?, ?)"
      )
      const insertLabel = db.prepare(
        "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('account', ?, 'INBOX')"
      )
      for (const [id, at] of [
        ['positive-low', 1],
        ['null-a', null],
        ['zero-b', 0],
        ['null-c', null],
        ['negative', -1]
      ] as const) {
        insertThread.run(id, at)
        insertLabel.run(id)
      }
      const ids: string[] = []
      let cursor: { at: number; id: string } | null = null
      for (;;) {
        const page = listInboxThreads(db, 'account', 2, cursor, splitId)
        if (page.length === 0) break
        ids.push(...page.map((row) => row.id))
        const last = page[page.length - 1]
        cursor = { at: last.lastMsgAt, id: last.id }
        expect(ids.length).toBeLessThanOrEqual(7)
      }
      expect(ids).toEqual(['newest', 'older', 'positive-low', 'null-a', 'null-c', 'zero-b', 'negative'])
      expect(listInboxThreads(db, 'account', 0, null, splitId)).toEqual([])
      expect(listInboxThreads(db, 'account', 1, null, splitId, 'null-c')).toEqual([
        expect.objectContaining({ id: 'null-c', lastMsgAt: 0 })
      ])
    }
  )

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

  it('counts follow-up-only threads in Snoozed without double-counting a thread holding both kinds', () => {
    // The Reminders list shows one row per thread with a pending reminder of
    // either kind; the sidebar count must match it (PR #101 review).
    const insertReminder = db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES ('account', ?, 'follow_up', ?, 'pending')`
    )
    insertReminder.run('older', 900)
    insertReminder.run('snoozed', 950)
    expect(listSnoozedThreads(db, 'account')).toHaveLength(2)
    expect(countSystemMailboxes(db, 'account').snoozed).toBe(2)
  })

  it('keeps derived mailbox membership identical to the label rules it replaces', async () => {
    // Parity is the whole risk of materializing membership: a count that drifts
    // from its list is worse than a slow one. Compare the stored rows against the
    // predicates the list queries use, over a fixture holding every awkward case.
    const insertThread = db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at, from_display, is_unread, is_starred,
                            has_attachment, is_inbox_visible)
       VALUES ('account', ?, ?, ?, 'Sender', 0, 0, 0, ?)`
    )
    const insertLabel = db.prepare(
      'INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
    )
    const insertMessage = db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                             body_text, labels_json)
       VALUES ('account', ?, ?, 'Sender', 's@e.test', 'snippet', ?, 'body', ?)`
    )
    const fixture: { id: string; visible: number; labels: string[]; messages: (string[] | null)[] }[] = [
      // A thread with one trashed message and one live one stays in All Mail.
      { id: 'partly-trashed', visible: 0, labels: ['TRASH'], messages: [['TRASH'], ['SENT']] },
      // Wholly trashed: out of All Mail and out of Sent.
      { id: 'all-trashed', visible: 0, labels: ['TRASH', 'SENT'], messages: [['TRASH', 'SENT']] },
      // Draft-only mail is never a mailbox row.
      { id: 'draft-only', visible: 0, labels: ['DRAFT'], messages: [['DRAFT']] },
      // Legacy rows predate per-message labels and fall back to thread labels.
      { id: 'legacy', visible: 1, labels: ['INBOX', 'STARRED'], messages: [null] },
      { id: 'spam-only', visible: 0, labels: ['SPAM'], messages: [['SPAM']] },
      { id: 'archived', visible: 0, labels: ['IMPORTANT'], messages: [['IMPORTANT']] },
      // Inbox membership needs the label and the visibility flag together.
      { id: 'inbox-hidden', visible: 0, labels: ['INBOX'], messages: [['INBOX']] },
      { id: 'starred-inbox', visible: 1, labels: ['INBOX', 'STARRED'], messages: [['INBOX', 'STARRED']] },
      { id: 'no-messages', visible: 1, labels: ['INBOX'], messages: [] }
    ]
    let messageId = 0
    for (const row of fixture) {
      insertThread.run(row.id, row.id, 500, row.visible)
      for (const label of row.labels) insertLabel.run('account', row.id, label)
      for (const labels of row.messages) {
        insertMessage.run(`fixture-${messageId++}`, row.id, 500, labels ? JSON.stringify(labels) : null)
      }
    }
    // The seeding above writes rows directly, the way a pre-upgrade profile holds
    // them, so the backfill is what fills membership here.
    expect((await runMailboxMembershipBackfill(db, 'account')).complete).toBe(true)

    const expectedFor = (view: MaterializedMailboxView): string[] => {
      const sql =
        view === 'allMail'
          ? `SELECT t.id FROM threads t WHERE t.account_id = ? AND (${allMailMembershipSql()})`
          : view === 'inbox'
            ? `SELECT t.id FROM threads t
               JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
                 AND tl.label_id = 'INBOX'
               WHERE t.account_id = ? AND t.is_inbox_visible = 1`
            : `SELECT t.id FROM thread_labels mailbox INDEXED BY idx_thread_labels_label
               JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
               WHERE mailbox.account_id = ? AND mailbox.label_id = '${view === 'sent' ? 'SENT' : 'STARRED'}'
                 AND (${labeledMailboxMembershipSql()})`
      return (db.prepare(sql).all('account') as { id: string }[]).map((row) => row.id).sort()
    }
    const storedFor = (view: MaterializedMailboxView): string[] =>
      (
        db
          .prepare(
            'SELECT thread_id FROM thread_mailboxes WHERE account_id = ? AND view = ? ORDER BY thread_id'
          )
          .all('account', view) as { thread_id: string }[]
      ).map((row) => row.thread_id)

    for (const view of MATERIALIZED_MAILBOX_VIEWS) {
      expect(storedFor(view), `${view} membership`).toEqual(expectedFor(view))
    }
    // Non-empty on both sides, so an all-empty result cannot pass this by accident.
    expect(storedFor('allMail').length).toBeGreaterThan(0)
    expect(storedFor('inbox')).toContain('starred-inbox')
    expect(storedFor('inbox')).not.toContain('inbox-hidden')
    expect(storedFor('allMail')).toContain('partly-trashed')
    expect(storedFor('allMail')).not.toContain('all-trashed')
    // A draft-only thread stays in All Mail, as it does in Gmail: the first
    // branch of the shipped rule asks only that the thread is not junk-labeled.
    expect(storedFor('allMail')).toContain('draft-only')
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
    insertMessage.run('mixed-trash-older', 'mixed', 250, '["TRASH","UNREAD","STARRED"]')
    db.prepare(
      `UPDATE threads
       SET from_display = 'Visible sender', snippet = 'Visible snippet',
           is_unread = 0, is_starred = 0, has_attachment = 0
       WHERE account_id = 'account' AND id = 'mixed'`
    ).run()
    db.prepare(
      `UPDATE messages
       SET from_name = 'Deleted sender', from_email = 'deleted@example.com',
           snippet = 'Deleted snippet', attachments_json = '[]'
       WHERE account_id = 'account' AND id = 'mixed-trash'`
    ).run()
    db.prepare(
      `UPDATE messages
       SET attachments_json = '[{"attachmentId":"deleted-file","filename":"deleted.pdf","inline":false}]'
       WHERE account_id = 'account' AND id = 'mixed-trash-older'`
    ).run()
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

    fillMembership(db)
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
    expect(listMailboxThreads(db, 'account', 'trash').find((row) => row.id === 'mixed')).toEqual(
      expect.objectContaining({
        fromDisplay: 'Deleted sender',
        snippet: 'Deleted snippet',
        unread: true,
        starred: true,
        hasAttachment: true
      })
    )
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

    fillMembership(db)
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
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('other-account', 'other@example.com')
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
    fillMembership(db, 'other-account')

    expect(mailboxIds('allMail')).not.toContain('other-mixed')
    expect(listMailboxThreads(db, 'other-account', 'allMail').map((row) => row.id)).toEqual(['other-mixed'])
  })

  it('uses a thread-key lookup for saved All Mail selections and the date index for pages', () => {
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
       SELECT account_id, id || '-message', id, last_msg_at, '[]' FROM threads`
    ).run()
    fillMembership(db)
    const explain = (threadId?: string): { rows: ReturnType<typeof listMailboxThreads>; plan: string[] } => {
      let plan: string[] = []
      const queryDb = {
        prepare: (sql: string) => {
          const statement = db.prepare(sql)
          return {
            all: (...params: unknown[]) => {
              plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
                (row) => row.detail
              )
              return statement.all(...params)
            }
          }
        }
      } as unknown as Db
      return { rows: listMailboxThreads(queryDb, 'account', 'allMail', 1, null, threadId), plan }
    }
    const ids = mailboxIds('allMail')
    const oldest = ids[ids.length - 1]
    expect(oldest).toBeDefined()
    for (const id of [oldest, 'missing-thread']) {
      const { rows, plan } = explain(id)
      expect(rows.map((row) => row.id)).toEqual(id === oldest ? [oldest] : [])
      const membership = plan.find((detail) => detail.startsWith('SEARCH mailbox '))
      expect(membership).toContain('(account_id=? AND thread_id=? AND view=?)')
      expect(membership).not.toContain('idx_thread_mailboxes_recent')
    }
    expect(explain().plan.some((detail) => detail.includes('idx_thread_mailboxes_recent'))).toBe(true)
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
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('account', 'test@example.com')
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
