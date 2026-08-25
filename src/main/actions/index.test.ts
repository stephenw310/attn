import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { type LabelMailboxView, listMailboxThreads } from '../db/queries'
import {
  actionQueueStatus,
  clearUndo,
  dropOutboxSendUndo,
  pendingActionCount,
  performTriage,
  recordOutboxSendUndo,
  undoLast
} from '.'
import { storeActionError } from './execute'

const ACCOUNT = 'outbox-undo@example.com'

afterEach(() => {
  clearUndo(ACCOUNT)
})

function queueDb(lastErrors: Array<string | null>): Db {
  return {
    prepare: () => ({
      // Mirrors the query's `last_error IS NOT NULL` filter: only failed rows
      // are ever materialized.
      all: () => lastErrors.filter((last_error) => last_error !== null).map((last_error) => ({ last_error })),
      get: () => ({ count: lastErrors.length })
    })
  } as unknown as Db
}

describe('action queue status', () => {
  it('keeps legacy failed rows visible in the pending count', () => {
    const db = queueDb([null])
    expect(pendingActionCount(db, 'a@example.com')).toBe(1)
  })

  it('surfaces typed auth pauses separately from ordinary pending work', () => {
    const db = queueDb([null, storeActionError(new Error('revoked'), 'auth')])
    // `paused` counts only the auth-held rows, so the header can name them
    // without implying the rest of the queue is stuck too.
    expect(actionQueueStatus(db, 'a@example.com')).toEqual({ pending: 2, paused: 1, authPaused: true })
  })

  it('does not count a non-auth failure as paused', () => {
    const db = queueDb([storeActionError(new Error('bad request'), 'permanent')])
    expect(actionQueueStatus(db, 'a@example.com')).toEqual({ pending: 1, paused: 0, authPaused: false })
  })
})

describe('mailbox triage projection', () => {
  it('moves known messages between All Mail and Trash before Gmail confirms the action', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(
        `INSERT INTO threads (account_id, id, subject, last_msg_at)
         VALUES (?, 'thread', 'Roadmap', 100)`
      ).run(ACCOUNT)
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES (?, 'message', 'thread', '["INBOX"]')`
      ).run(ACCOUNT)
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES (?, 'thread', 'INBOX')`
      ).run(ACCOUNT)

      const mailboxIds = (view: LabelMailboxView): string[] =>
        listMailboxThreads(db, ACCOUNT, view).map((row) => row.id)
      performTriage(db, ACCOUNT, { kind: 'trash', threadIds: ['thread'] }, false)
      expect(mailboxIds('allMail')).toEqual([])
      expect(mailboxIds('trash')).toEqual(['thread'])

      performTriage(db, ACCOUNT, { kind: 'untrash', threadIds: ['thread'] }, false)
      expect(mailboxIds('allMail')).toEqual(['thread'])
      expect(mailboxIds('trash')).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('outbox undo stack', () => {
  it('reopens only a row that is still queued', () => {
    const run = vi.fn(() => ({ changes: 1 }))
    const db = { prepare: vi.fn(() => ({ run })) } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Send undone', reopenDraftId: 'outbox-1' })
    expect(run).toHaveBeenCalledWith(expect.any(Number), ACCOUNT, 'outbox-1')
  })

  it('reports an already-fired send and consumes that undo entry', () => {
    const db = {
      prepare: vi.fn(() => ({ run: vi.fn(() => ({ changes: 0 })) }))
    } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Already sent' })
    expect(undoLast(db, ACCOUNT)).toBeNull()
  })

  it('drops the stale send entry when a failed message is reopened explicitly', () => {
    const db = { prepare: vi.fn() } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')
    dropOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toBeNull()
  })
})
