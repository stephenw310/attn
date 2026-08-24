import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../db'
import type { SchedulerTime } from '../time'
import { searchMessageIndex } from './fts'
import { type FtsBackfillProgress, planFtsBackfillStart, runFtsBackfill } from './ftsBackfill'
import { persistThread } from './persist'

const ACCOUNT = 'account@example.test'

const immediateTime: SchedulerTime = {
  now: () => 0,
  timers: {
    setTimeout: (callback) => {
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {}
  }
}

/**
 * Insert rows the way a manually upgraded revision-18 profile holds them:
 * present in `messages` with no index rows, bypassing `persistThread`.
 */
function insertUnindexedMessage(db: Db, messageId: string, threadId: string, bodyText: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO threads (account_id, id, subject, snippet, last_msg_at, from_display)
     VALUES (?, ?, ?, '', 100, 'Sender')`
  ).run(ACCOUNT, threadId, `Subject ${threadId}`)
  db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                           body_text, recipients_json, attachments_json, labels_json, references_json)
     VALUES (?, ?, ?, 'Sender', 'sender@example.test', '', 100, ?, '{}', '[]', '[]', '[]')`
  ).run(ACCOUNT, messageId, threadId, bodyText)
}

function mappedCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM message_fts_map').get() as { count: number }).count
}

function cursor(db: Db): string | null {
  const row = db.prepare('SELECT fts_cursor FROM sync_state WHERE account_id = ?').get(ACCOUNT) as
    | { fts_cursor: string | null }
    | undefined
  return row?.fts_cursor ?? null
}

describe('planFtsBackfillStart', () => {
  it('maps the cursor grammar to start plans', () => {
    expect(planFtsBackfillStart(null)).toEqual({ kind: 'run' })
    expect(planFtsBackfillStart(undefined)).toEqual({ kind: 'run' })
    expect(planFtsBackfillStart('fts')).toEqual({ kind: 'run' })
    expect(planFtsBackfillStart('fts:m-17')).toEqual({ kind: 'run', afterMessageId: 'm-17' })
    expect(planFtsBackfillStart('done')).toEqual({ kind: 'skip' })
    expect(() => planFtsBackfillStart('lifetime:oops')).toThrow('Invalid FTS backfill cursor')
    expect(() => planFtsBackfillStart('fts:')).toThrow('Invalid FTS backfill cursor')
  })
})

describe('runFtsBackfill', () => {
  it('indexes pre-index rows to done, creating the missing sync_state row', async () => {
    const db = openDatabase(':memory:')
    try {
      for (let index = 1; index <= 5; index++) {
        insertUnindexedMessage(db, `m-${index}`, `t-${index}`, `legacy payload ${index}`)
      }
      const result = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: () => {}, onError: (error) => expect.unreachable(String(error)) },
        { batchSize: 2, batchPauseMs: 0 }
      )
      expect(result).toEqual({ messagesIndexed: 5 })
      expect(cursor(db)).toBe('done')
      expect(mappedCount(db)).toBe(5)
      expect(searchMessageIndex(db, ACCOUNT, 'legacy', 10)).toHaveLength(5)
    } finally {
      db.close()
    }
  })

  it('resumes from the persisted checkpoint without re-indexing finished rows', async () => {
    const db = openDatabase(':memory:')
    try {
      for (let index = 1; index <= 6; index++) {
        insertUnindexedMessage(db, `m-${index}`, `t-${index}`, `legacy payload ${index}`)
      }
      let alive = true
      const interrupted = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: () => {}, onError: (error) => expect.unreachable(String(error)) },
        {
          batchSize: 2,
          batchPauseMs: 0,
          shouldContinue: () => alive,
          onBatchCheckpoint: () => {
            alive = false
          }
        }
      )
      expect(interrupted).toBeNull()
      expect(cursor(db)).toBe('fts:m-2')
      expect(mappedCount(db)).toBe(2)

      const resumed = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: () => {}, onError: (error) => expect.unreachable(String(error)) },
        { batchSize: 10, batchPauseMs: 0 }
      )
      expect(resumed).toEqual({ messagesIndexed: 4 })
      expect(cursor(db)).toBe('done')
      expect(mappedCount(db)).toBe(6)
      // Exactly one index row per message: nothing double-indexed across runs.
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM message_fts_map map
             JOIN messages m ON m.account_id = map.account_id AND m.id = map.message_id`
          )
          .get() as { count: number }
      ).toEqual({ count: 6 })
    } finally {
      db.close()
    }
  })

  it('skips rows already indexed inline and finishes immediately on a fresh store', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, ACCOUNT, {
        id: 't-inline',
        messages: [
          {
            id: 'm-inline',
            threadId: 't-inline',
            labelIds: ['INBOX'],
            internalDate: '100',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Maya <maya@example.test>' },
                { name: 'To', value: 'to@example.test' },
                { name: 'Subject', value: 'Inline indexed' }
              ],
              body: { data: Buffer.from('inline body').toString('base64url') }
            }
          }
        ]
      })
      const result = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: () => {}, onError: (error) => expect.unreachable(String(error)) },
        { batchPauseMs: 0 }
      )
      expect(result).toEqual({ messagesIndexed: 0 })
      expect(cursor(db)).toBe('done')
      expect(mappedCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('reports done without work when the cursor is already finished', async () => {
    const db = openDatabase(':memory:')
    try {
      insertUnindexedMessage(db, 'm-late', 't-late', 'late arrival')
      db.prepare('INSERT INTO sync_state (account_id, fts_cursor) VALUES (?, ?)').run(ACCOUNT, 'done')
      const result = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: () => {}, onError: (error) => expect.unreachable(String(error)) },
        { batchPauseMs: 0 }
      )
      expect(result).toEqual({ messagesIndexed: 0 })
      expect(mappedCount(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('yields to interactive work before each batch', async () => {
    const db = openDatabase(':memory:')
    try {
      insertUnindexedMessage(db, 'm-1', 't-1', 'yielding payload')
      const reasons: FtsBackfillProgress['reason'][] = []
      let yieldsRemaining = 2
      const result = await runFtsBackfill(
        db,
        ACCOUNT,
        { onProgress: (progress) => reasons.push(progress.reason), onError: () => {} },
        {
          time: immediateTime,
          batchPauseMs: 0,
          shouldYield: () => yieldsRemaining-- > 0
        }
      )
      expect(result).toEqual({ messagesIndexed: 1 })
      expect(reasons.filter((reason) => reason === 'foreground-yield')).toHaveLength(2)
      expect(cursor(db)).toBe('done')
    } finally {
      db.close()
    }
  })
})
