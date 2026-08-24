import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import type { GmailMessage, GmailPart, GmailThread } from '../gmail/parse'
import { hydrateMissingThreadBodies } from './bodies'
import { indexThreadMessages, refreshMessageBodyFromStore, searchCoverage, searchMessageIndex } from './fts'
import { deleteThread, persistThread } from './persist'
import type { MailProvider } from './provider'

const ACCOUNT = 'account@example.test'

interface TestMessageInput {
  id: string
  threadId: string
  subject?: string
  from?: string
  to?: string
  bodyText?: string
  bodyHtml?: string
  attachments?: { attachmentId: string; filename: string }[]
  externalBodyId?: string
  labelIds?: string[]
  internalDate?: string
}

function testMessage(input: TestMessageInput): GmailMessage {
  const parts: GmailPart[] = []
  if (input.bodyText !== undefined) {
    parts.push({ mimeType: 'text/plain', body: { data: Buffer.from(input.bodyText).toString('base64url') } })
  }
  if (input.bodyHtml !== undefined) {
    parts.push({ mimeType: 'text/html', body: { data: Buffer.from(input.bodyHtml).toString('base64url') } })
  }
  if (input.externalBodyId !== undefined) {
    parts.push({ mimeType: 'text/plain', body: { attachmentId: input.externalBodyId } })
  }
  for (const attachment of input.attachments ?? []) {
    parts.push({
      mimeType: 'application/pdf',
      filename: attachment.filename,
      body: { attachmentId: attachment.attachmentId, size: 3 }
    })
  }
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.labelIds ?? ['INBOX'],
    internalDate: input.internalDate ?? '100',
    snippet: `snippet ${input.id}`,
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: input.from ?? 'Maya Chen <maya@example.test>' },
        { name: 'To', value: input.to ?? 'Recipient <recipient@example.test>' },
        { name: 'Subject', value: input.subject ?? 'Subject' }
      ],
      parts
    }
  }
}

function testThread(id: string, messages: GmailMessage[]): GmailThread {
  return { id, messages }
}

function mapRows(db: ReturnType<typeof openDatabase>): { message_id: string; fts_rowid: number }[] {
  return db.prepare('SELECT message_id, fts_rowid FROM message_fts_map ORDER BY message_id').all() as {
    message_id: string
    fts_rowid: number
  }[]
}

function ftsRowCount(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM message_fts').get() as { count: number }).count
}

function matches(db: ReturnType<typeof openDatabase>, match: string): string[] {
  return searchMessageIndex(db, ACCOUNT, match, 50).map((hit) => hit.threadId)
}

describe('message index maintenance', () => {
  it('indexes subject, sender, recipients, body, and filenames on persist', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [
          testMessage({
            id: 'm1',
            threadId: 't1',
            subject: 'Quarterly budget review',
            from: 'Priya Patel <priya@sender.test>',
            to: 'Casey Recipientson <casey@recipient.test>',
            bodyText: 'The proposal deadline moved to Friday.',
            attachments: [{ attachmentId: 'a1', filename: 'forecast.xlsx' }]
          })
        ])
      )
      expect(mapRows(db)).toEqual([{ message_id: 'm1', fts_rowid: expect.any(Number) }])
      expect(ftsRowCount(db)).toBe(1)
      expect(matches(db, 'budget')).toEqual(['t1'])
      expect(matches(db, 'priya')).toEqual(['t1'])
      expect(matches(db, 'casey')).toEqual(['t1'])
      expect(matches(db, 'proposal')).toEqual(['t1'])
      expect(matches(db, 'forecast')).toEqual(['t1'])
      expect(matches(db, 'absent')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('supports as-you-type prefixes and diacritic-insensitive terms', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [
          testMessage({ id: 'm1', threadId: 't1', subject: 'Café rendezvous', bodyText: 'Latte tasting' })
        ])
      )
      expect(matches(db, 'cafe')).toEqual(['t1'])
      expect(matches(db, 'café')).toEqual(['t1'])
      expect(matches(db, 'la*')).toEqual(['t1'])
      expect(matches(db, 'rend*')).toEqual(['t1'])
    } finally {
      db.close()
    }
  })

  it('indexes stripped text for HTML-only bodies, never the markup', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [
          testMessage({
            id: 'm1',
            threadId: 't1',
            bodyHtml: '<div class="wrapper"><p>Invoice attached below</p></div>'
          })
        ])
      )
      expect(matches(db, 'invoice')).toEqual(['t1'])
      expect(matches(db, 'div')).toEqual([])
      expect(matches(db, 'wrapper')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('re-persisting with label-only changes leaves index rows untouched', () => {
    const db = openDatabase(':memory:')
    try {
      const snapshot = (labels: string[]): GmailThread =>
        testThread('t1', [
          testMessage({ id: 'm1', threadId: 't1', subject: 'Stable', bodyText: 'Body', labelIds: labels })
        ])
      persistThread(db, ACCOUNT, snapshot(['INBOX', 'UNREAD']))
      const before = mapRows(db)
      persistThread(db, ACCOUNT, snapshot(['INBOX']))
      expect(mapRows(db)).toEqual(before)
      // Reconciling the unchanged thread performs zero index writes: the hot
      // triage path must not churn FTS tokens.
      expect(indexThreadMessages(db, ACCOUNT, 't1')).toEqual({
        inserted: 0,
        updated: 0,
        removed: 0,
        unchanged: 1
      })
      expect(ftsRowCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('drops index rows for messages pruned from the latest snapshot', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [
          testMessage({ id: 'm1', threadId: 't1', bodyText: 'kept message' }),
          testMessage({ id: 'm2', threadId: 't1', bodyText: 'vanishing message' })
        ])
      )
      expect(matches(db, 'vanishing')).toEqual(['t1'])
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [testMessage({ id: 'm1', threadId: 't1', bodyText: 'kept message' })])
      )
      expect(matches(db, 'vanishing')).toEqual([])
      expect(matches(db, 'kept')).toEqual(['t1'])
      expect(mapRows(db).map((row) => row.message_id)).toEqual(['m1'])
      expect(ftsRowCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('leaves no index rows behind a tombstoned thread', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [testMessage({ id: 'm1', threadId: 't1', bodyText: 'tombstone target' })])
      )
      deleteThread(db, ACCOUNT, 't1')
      expect(matches(db, 'tombstone')).toEqual([])
      expect(mapRows(db)).toEqual([])
      expect(ftsRowCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('prunes the index when a snapshot degrades to draft-only', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [testMessage({ id: 'm1', threadId: 't1', bodyText: 'soon replaced' })])
      )
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [testMessage({ id: 'd1', threadId: 't1', bodyText: 'draft', labelIds: ['DRAFT'] })])
      )
      expect(matches(db, 'replaced')).toEqual([])
      expect(ftsRowCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('makes a hydrated out-of-line body searchable through the production fill path', async () => {
    const db = openDatabase(':memory:')
    try {
      const thread = testThread('t1', [
        testMessage({ id: 'm1', threadId: 't1', subject: 'Hydration', externalBodyId: 'ext-1' })
      ])
      persistThread(db, ACCOUNT, thread)
      expect(matches(db, 'clandestine')).toEqual([])

      const provider = {
        getAttachmentData: vi.fn(async () => Buffer.from('a clandestine payload').toString('base64url'))
      } as unknown as MailProvider
      await hydrateMissingThreadBodies(db, provider, ACCOUNT, thread)
      expect(matches(db, 'clandestine')).toEqual(['t1'])
    } finally {
      db.close()
    }
  })

  it('ranks a thread on its best-matching message, wherever it sits', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t-weak', [
          testMessage({
            id: 'w1',
            threadId: 't-weak',
            bodyText:
              'A long unrelated status report that mentions quarterly once among many other filler words about logistics, scheduling, and venue planning for the offsite.'
          })
        ])
      )
      persistThread(
        db,
        ACCOUNT,
        testThread('t-strong', [
          testMessage({ id: 's1', threadId: 't-strong', bodyText: 'greeting' }),
          testMessage({ id: 's2', threadId: 't-strong', bodyText: 'agenda' }),
          testMessage({ id: 's3', threadId: 't-strong', bodyText: 'notes' }),
          testMessage({ id: 's4', threadId: 't-strong', bodyText: 'minutes' }),
          testMessage({
            id: 's5',
            threadId: 't-strong',
            bodyText: 'quarterly quarterly quarterly'
          })
        ])
      )
      expect(matches(db, 'quarterly')).toEqual(['t-strong', 't-weak'])
    } finally {
      db.close()
    }
  })

  it('refreshes the indexed body from the stored row and ignores unmapped ids', () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [testMessage({ id: 'm1', threadId: 't1', bodyText: 'original body' })])
      )
      db.prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?').run(
        'rewritten body',
        ACCOUNT,
        'm1'
      )
      refreshMessageBodyFromStore(db, ACCOUNT, 'm1')
      expect(matches(db, 'rewritten')).toEqual(['t1'])
      expect(matches(db, 'original')).toEqual([])
      expect(() => refreshMessageBodyFromStore(db, ACCOUNT, 'missing')).not.toThrow()
    } finally {
      db.close()
    }
  })
})

describe('search coverage', () => {
  it('reports cursor completeness and body hydration counts', () => {
    const db = openDatabase(':memory:')
    try {
      expect(searchCoverage(db, ACCOUNT)).toEqual({
        headersComplete: false,
        indexComplete: false,
        attachmentFlagsComplete: false,
        messagesTotal: 0,
        messagesWithBody: 0
      })
      persistThread(
        db,
        ACCOUNT,
        testThread('t1', [
          testMessage({ id: 'm1', threadId: 't1', bodyText: 'hydrated' }),
          testMessage({ id: 'm2', threadId: 't1', subject: 'Header only' })
        ])
      )
      db.prepare(
        `INSERT INTO sync_state (account_id, sweep_cursor, attachment_cursor, fts_cursor)
         VALUES (?, 'done', 'done', 'done')`
      ).run(ACCOUNT)
      expect(searchCoverage(db, ACCOUNT)).toEqual({
        headersComplete: true,
        indexComplete: true,
        attachmentFlagsComplete: true,
        messagesTotal: 2,
        messagesWithBody: 1
      })
    } finally {
      db.close()
    }
  })
})
