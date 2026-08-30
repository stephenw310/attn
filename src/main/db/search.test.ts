import { describe, expect, it } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { GmailMessage, GmailThread } from '../gmail/parse'
import { saveDraft } from '../outbox/drafts'
import { persistThread } from '../sync/persist'
import { openDatabase } from './index'
import { listMailboxThreads } from './queries'
import { searchThreads } from './search'

const ACCOUNT = 'search@example.test'

interface MessageInput {
  id: string
  threadId: string
  from: string
  subject: string
  body: string
  at: string
  labels?: string[]
  attachment?: string
  to?: string
}

function message(input: MessageInput): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.labels ?? ['INBOX'],
    internalDate: input.at,
    snippet: input.body,
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: input.from },
        { name: 'To', value: input.to ?? 'Search User <search@example.test>' },
        { name: 'Subject', value: input.subject }
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(input.body).toString('base64url') } },
        ...(input.attachment
          ? [
              {
                mimeType: 'application/pdf',
                filename: input.attachment,
                body: { attachmentId: `${input.id}-attachment`, size: 100 }
              }
            ]
          : [])
      ]
    }
  }
}

function thread(id: string, input: Omit<MessageInput, 'id' | 'threadId'>): GmailThread {
  return { id, messages: [message({ ...input, id: `m-${id}`, threadId: id })] }
}

function ids(db: ReturnType<typeof openDatabase>, query: string): string[] {
  return searchThreads(db, ACCOUNT, query).rows.map((row) => row.id)
}

describe('searchThreads', () => {
  it('combines FTS terms and relational operators in one ranked result query', () => {
    const db = openDatabase(':memory:')
    try {
      const afterBoundary = String(Date.UTC(2026, 0, 5))
      persistThread(
        db,
        ACCOUNT,
        thread('target', {
          from: 'Acme Planning <updates@acme.com>',
          subject: 'Annual roadmap',
          body: 'The launch plan is attached.',
          at: afterBoundary,
          attachment: 'roadmap.pdf',
          labels: ['INBOX', 'UNREAD']
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('no-attachment', {
          from: 'Acme Planning <updates@acme.com>',
          subject: 'Annual roadmap',
          body: 'No file on this message.',
          at: afterBoundary
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('wrong-sender', {
          from: 'Other Sender <other@example.test>',
          subject: 'Annual roadmap',
          body: 'The launch plan is attached.',
          at: afterBoundary,
          attachment: 'roadmap.pdf'
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('too-old', {
          from: 'Acme Planning <updates@acme.com>',
          subject: 'Annual roadmap',
          body: 'The launch plan is attached.',
          at: String(Date.UTC(2025, 11, 20)),
          attachment: 'roadmap.pdf'
        })
      )

      const result = ids(db, 'from:acme.com has:attachment after:2026-01-01')
      const control = (
        db
          .prepare(
            `SELECT DISTINCT t.id
             FROM threads t
             JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
             WHERE t.account_id = ? AND m.from_email LIKE '%@acme.com'
               AND t.has_attachment = 1 AND m.internal_date >= ?`
          )
          .all(ACCOUNT, Date.UTC(2026, 0, 1)) as { id: string }[]
      ).map((row) => row.id)
      expect(result).toEqual(control)
      expect(result).toEqual(['target'])
    } finally {
      db.close()
    }
  })

  it('supports fields, phrases, state, dates, system mailboxes, and user labels', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        thread('selected', {
          from: 'Alex Rivera <alex@example.test>',
          to: 'Morgan Lee <morgan@example.test>',
          subject: 'Quarterly budget review',
          body: 'Forecast details',
          at: String(Date.UTC(2026, 0, 10)),
          labels: ['INBOX', 'UNREAD', 'STARRED', 'Label_Project']
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('other', {
          from: 'Alex Rivera <alex@example.test>',
          subject: 'Quarterly notes',
          body: 'Unrelated details',
          at: String(Date.UTC(2025, 11, 1))
        })
      )
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Project', 'Project Alpha', 'user')"
      ).run(ACCOUNT)
      db.prepare(
        "INSERT INTO reminders (account_id, thread_id, kind, due_at, state) VALUES (?, 'selected', 'snooze', ?, 'pending')"
      ).run(ACCOUNT, Date.UTC(2026, 1, 1))

      expect(ids(db, 'from:alex to:morgan subject:"quarterly budget"')).toEqual(['selected'])
      expect(ids(db, 'is:unread is:starred is:snoozed')).toEqual(['selected'])
      expect(ids(db, 'after:2026-01-01 before:2026-02-01')).toEqual(['selected'])
      expect(ids(db, 'in:inbox')).toEqual(['selected', 'other'])
      expect(ids(db, 'in:"Project Alpha"')).toEqual(['selected'])
    } finally {
      db.close()
    }
  })

  it('orders text results newest first even when an older message ranks higher', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        thread('older-strong-match', {
          from: 'Older <older@example.test>',
          subject: 'Project project project project',
          body: 'Project project project project project project',
          at: String(Date.UTC(2025, 0, 1))
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('newer-weak-match', {
          from: 'Newer <newer@example.test>',
          subject: 'Status note',
          body: 'One project update',
          at: String(Date.UTC(2026, 0, 1))
        })
      )

      expect(ids(db, 'project')).toEqual(['newer-weak-match', 'older-strong-match'])
    } finally {
      db.close()
    }
  })

  it('searches the same readable message projection that its result reader opens', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        thread('spam-only', {
          from: 'Spam Sender <spam@example.test>',
          subject: 'Spam offer',
          body: 'junkonlyneedle',
          at: '200',
          labels: ['SPAM', 'UNREAD']
        })
      )
      persistThread(db, ACCOUNT, {
        id: 'mixed',
        messages: [
          message({
            id: 'mixed-normal',
            threadId: 'mixed',
            from: 'Normal Sender <normal@example.test>',
            subject: 'Mixed conversation',
            body: 'Visible message',
            at: '300',
            labels: ['INBOX']
          }),
          message({
            id: 'mixed-spam',
            threadId: 'mixed',
            from: 'Spam Sender <spam@example.test>',
            subject: 'Mixed conversation',
            body: 'mixedjunkneedle',
            at: '400',
            labels: ['SPAM']
          })
        ]
      })

      expect(ids(db, 'junkonlyneedle')).toEqual([])
      expect(ids(db, 'is:unread')).toEqual([])
      expect(ids(db, 'mixedjunkneedle')).toEqual([])
      expect(ids(db, 'in:spam junkonlyneedle')).toEqual(['spam-only'])
      expect(ids(db, 'in:spam mixedjunkneedle')).toEqual(['mixed'])
    } finally {
      db.close()
    }
  })

  it('uses the mailbox list membership rules for sent, starred, and user labels', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        thread('visible', {
          from: 'Search User <search@example.test>',
          subject: 'Visible sent copy',
          body: 'Visible sent body',
          at: '300',
          labels: ['SENT', 'STARRED', 'Label_Project']
        })
      )
      persistThread(
        db,
        ACCOUNT,
        thread('junk', {
          from: 'Search User <search@example.test>',
          subject: 'Trashed sent copy',
          body: 'Trashed sent body',
          at: '200',
          labels: ['SENT', 'STARRED', 'TRASH', 'Label_Project']
        })
      )
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Project', 'Project Alpha', 'user')"
      ).run(ACCOUNT)

      expect(ids(db, 'in:sent')).toEqual(listMailboxThreads(db, ACCOUNT, 'sent').map((row) => row.id))
      expect(ids(db, 'in:starred')).toEqual(listMailboxThreads(db, ACCOUNT, 'starred').map((row) => row.id))
      expect(ids(db, 'in:"Project Alpha"')).toEqual(['visible'])
    } finally {
      db.close()
    }
  })

  it('combines message operators on one visible mailbox projection', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, ACCOUNT, {
        id: 'mixed-junk',
        messages: [
          message({
            id: 'mixed-normal',
            threadId: 'mixed-junk',
            from: 'Normal Sender <normal@example.test>',
            subject: 'Mixed mailbox state',
            body: 'Visible old message',
            at: String(Date.UTC(2025, 0, 1)),
            labels: ['INBOX']
          }),
          message({
            id: 'mixed-spam',
            threadId: 'mixed-junk',
            from: 'Spam Sender <spam@example.test>',
            subject: 'Mixed mailbox state',
            body: 'Spam attachment message',
            at: String(Date.UTC(2026, 1, 1)),
            labels: ['SPAM', 'UNREAD', 'STARRED'],
            attachment: 'spam.pdf'
          })
        ]
      })
      persistThread(db, ACCOUNT, {
        id: 'split-operators',
        messages: [
          message({
            id: 'split-acme',
            threadId: 'split-operators',
            from: 'Acme <updates@acme.com>',
            subject: 'Split operators',
            body: 'Old sender match',
            at: String(Date.UTC(2025, 0, 1)),
            labels: ['INBOX']
          }),
          message({
            id: 'split-other',
            threadId: 'split-operators',
            from: 'Other <other@example.test>',
            subject: 'Split operators',
            body: 'New attachment',
            at: String(Date.UTC(2026, 1, 1)),
            labels: ['INBOX'],
            attachment: 'other.pdf'
          })
        ]
      })
      persistThread(
        db,
        ACCOUNT,
        thread('flag-only-attachment', {
          from: 'Flagged <flagged@example.test>',
          subject: 'Lifetime flag only',
          body: 'Metadata has no part tree',
          at: String(Date.UTC(2026, 1, 1)),
          labels: ['INBOX']
        })
      )
      db.prepare("UPDATE threads SET has_attachment = 1 WHERE id = 'flag-only-attachment'").run()

      const spamResult = searchThreads(db, ACCOUNT, 'in:spam is:unread is:starred has:attachment')
      expect(spamResult.rows).toHaveLength(1)
      expect(spamResult.rows[0]).toMatchObject({
        id: 'mixed-junk',
        fromDisplay: 'Spam Sender',
        snippet: 'Spam attachment message',
        unread: true,
        starred: true,
        hasAttachment: true
      })
      expect(ids(db, 'after:2026-01-01')).toEqual(['flag-only-attachment', 'split-operators'])
      expect(ids(db, 'from:acme.com has:attachment after:2026-01-01')).toEqual([])
      expect(ids(db, 'from:flagged has:attachment')).toEqual(['flag-only-attachment'])
    } finally {
      db.close()
    }
  })

  it('searches the outbox-backed Drafts view and returns reopenable draft rows', () => {
    const db = openDatabase(':memory:')
    try {
      const draftId = saveDraft(
        db,
        ACCOUNT,
        {
          ...emptyDraftInput(),
          to: [{ name: 'Morgan', email: 'morgan@example.test' }],
          subject: 'Quarterly draft review',
          bodyText: 'Unsent forecast notes'
        },
        Date.UTC(2026, 0, 10)
      )

      const result = searchThreads(db, ACCOUNT, 'in:drafts to:morgan subject:quarterly after:2026-01-01')
      expect(result.rows).toEqual([])
      expect(result.drafts.map((draft) => draft.id)).toEqual([draftId])
      expect(searchThreads(db, ACCOUNT, 'in:drafts in:inbox').drafts).toEqual([])
      expect(searchThreads(db, ACCOUNT, 'in:drafts is:unread').drafts).toEqual([])
    } finally {
      db.close()
    }
  })

  it('returns no rows for empty input and searches unknown operators literally', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        thread('literal', {
          from: 'Sender <sender@example.test>',
          subject: 'Re budget',
          body: 'Follow up tomorrow',
          at: '100'
        })
      )
      expect(ids(db, '')).toEqual([])
      expect(ids(db, 're: budget')).toEqual(['literal'])
    } finally {
      db.close()
    }
  })
})

describe('bounded search candidates', () => {
  it('marks a search partial when its recency window fills, and stays exact below it', () => {
    const db = openDatabase(':memory:')
    try {
      for (let index = 0; index < 12; index++) {
        persistThread(
          db,
          ACCOUNT,
          thread(`bulk-thread-${index}`, {
            from: 'Planner <plans@example.test>',
            subject: 'Quarterly planning',
            body: 'recurring token in every message',
            at: String(1_700_000_000_000 + index * 60_000)
          })
        )
      }

      // Window larger than the corpus: exact, and not marked partial.
      const whole = searchThreads(db, ACCOUNT, 'recurring', { recentMessageLimit: 50 })
      expect(whole.partial).toBe(false)
      expect(whole.rows).toHaveLength(12)

      // Window smaller than the corpus: the newest matches, marked partial.
      const bounded = searchThreads(db, ACCOUNT, 'recurring', { recentMessageLimit: 4 })
      expect(bounded.partial).toBe(true)
      expect(bounded.rows.map((row) => row.id)).toEqual([
        'bulk-thread-11',
        'bulk-thread-10',
        'bulk-thread-9',
        'bulk-thread-8'
      ])

      // A filter that rejects everything inside the window still reports partial,
      // which is the case the marker exists for: an empty result that is not proof
      // the account holds no match.
      const filtered = searchThreads(db, ACCOUNT, 'recurring is:unread', { recentMessageLimit: 4 })
      expect(filtered.rows).toEqual([])
      expect(filtered.partial).toBe(true)
    } finally {
      db.close()
    }
  })
})
