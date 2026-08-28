import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { type LabelMailboxView, listMailboxThreads } from '../db/queries'
import { SnoozeScheduler } from '../scheduler'
import type { TimerHandle } from '../time'
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

  it('moves mixed pre-states, cancels pending snoozes, and undoes both exactly', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      const insertLabel = db.prepare('INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)')
      insertLabel.run(ACCOUNT, 'Label_Source', 'Source', 'user')
      insertLabel.run(ACCOUNT, 'Label_Destination', 'Destination', 'user')
      const insertThread = db.prepare(
        'INSERT INTO threads (account_id, id, subject, last_msg_at) VALUES (?, ?, ?, 1)'
      )
      const insertMessage = db.prepare(
        'INSERT INTO messages (account_id, id, thread_id, labels_json) VALUES (?, ?, ?, ?)'
      )
      const insertThreadLabel = db.prepare(
        'INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
      )
      insertThread.run(ACCOUNT, 'inbox', 'Inbox thread')
      insertMessage.run(
        ACCOUNT,
        'inbox-message',
        'inbox',
        JSON.stringify(['INBOX', 'UNREAD', 'STARRED', 'Label_Source', 'Label_Keep'])
      )
      for (const label of ['INBOX', 'UNREAD', 'STARRED', 'Label_Source', 'Label_Keep']) {
        insertThreadLabel.run(ACCOUNT, 'inbox', label)
      }
      insertThread.run(ACCOUNT, 'snoozed', 'Snoozed thread')
      insertMessage.run(ACCOUNT, 'snoozed-message', 'snoozed', JSON.stringify(['Label_Destination']))
      insertThreadLabel.run(ACCOUNT, 'snoozed', 'Label_Destination')
      db.prepare(
        `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
         VALUES (?, 'snoozed', 'snooze', 100, 'pending')`
      ).run(ACCOUNT)

      const result = performTriage(db, ACCOUNT, {
        kind: 'move',
        threadIds: ['inbox', 'snoozed'],
        destination: { kind: 'label', labelId: 'Label_Destination' },
        sourceLabelId: 'Label_Source'
      })

      const labelsFor = (threadId: string): string[] =>
        (
          db
            .prepare(
              'SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id'
            )
            .all(ACCOUNT, threadId) as Array<{ label_id: string }>
        ).map((row) => row.label_id)
      expect(result).toEqual({ label: '2 moved' })
      expect(labelsFor('inbox')).toEqual(['Label_Destination', 'Label_Keep', 'STARRED', 'UNREAD'])
      expect(labelsFor('snoozed')).toEqual(['Label_Destination'])
      expect(db.prepare("SELECT due_at, state FROM reminders WHERE thread_id = 'snoozed'").get()).toEqual({
        due_at: 100,
        state: 'canceled'
      })
      expect(pendingActionCount(db, ACCOUNT)).toBe(1)

      const scheduler = new SnoozeScheduler(
        db,
        () => ACCOUNT,
        () => {},
        () => {},
        {
          now: () => 200,
          timers: {
            setTimeout: () => ({}) as TimerHandle,
            clearTimeout: () => {}
          }
        }
      )
      scheduler.refresh()
      expect(labelsFor('snoozed')).toEqual(['Label_Destination'])

      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid 2 moved' })
      expect(labelsFor('inbox')).toEqual(['INBOX', 'Label_Keep', 'Label_Source', 'STARRED', 'UNREAD'])
      expect(labelsFor('snoozed')).toEqual(['Label_Destination'])
      expect(db.prepare("SELECT due_at, state FROM reminders WHERE thread_id = 'snoozed'").get()).toEqual({
        due_at: 100,
        state: 'pending'
      })
      expect(pendingActionCount(db, ACCOUNT)).toBe(2)
    } finally {
      db.close()
    }
  })

  it('queues Gmail deltas for Trash, Important, and Other and undoes the system labels exactly', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      const insertThread = db.prepare(
        'INSERT INTO threads (account_id, id, subject, last_msg_at) VALUES (?, ?, ?, 1)'
      )
      const insertMessage = db.prepare(
        'INSERT INTO messages (account_id, id, thread_id, labels_json) VALUES (?, ?, ?, ?)'
      )
      const insertThreadLabel = db.prepare(
        'INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
      )
      insertThread.run(ACCOUNT, 'trashed', 'Trashed thread')
      insertMessage.run(ACCOUNT, 'trashed-message', 'trashed', JSON.stringify(['TRASH', 'STARRED']))
      insertThreadLabel.run(ACCOUNT, 'trashed', 'TRASH')
      insertThreadLabel.run(ACCOUNT, 'trashed', 'STARRED')
      insertThread.run(ACCOUNT, 'important', 'Important thread')
      insertMessage.run(
        ACCOUNT,
        'important-message',
        'important',
        JSON.stringify(['INBOX', 'IMPORTANT', 'UNREAD'])
      )
      for (const label of ['INBOX', 'IMPORTANT', 'UNREAD']) {
        insertThreadLabel.run(ACCOUNT, 'important', label)
      }

      performTriage(db, ACCOUNT, {
        kind: 'move',
        threadIds: ['trashed'],
        destination: { kind: 'important' },
        sourceLabelId: null
      })
      const labelsFor = (threadId: string): string[] =>
        (
          db
            .prepare(
              'SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id'
            )
            .all(ACCOUNT, threadId) as Array<{ label_id: string }>
        ).map((row) => row.label_id)
      expect(labelsFor('trashed')).toEqual(['IMPORTANT', 'INBOX', 'STARRED'])
      expect(
        JSON.parse(
          (db.prepare('SELECT payload FROM action_queue WHERE id = 1').get() as { payload: string }).payload
        )
      ).toMatchObject({ add: ['INBOX', 'IMPORTANT'], remove: ['TRASH'], actionKind: 'move' })

      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid moved' })
      expect(labelsFor('trashed')).toEqual(['STARRED', 'TRASH'])

      performTriage(
        db,
        ACCOUNT,
        {
          kind: 'move',
          threadIds: ['important'],
          destination: { kind: 'other' },
          sourceLabelId: null
        },
        false
      )
      expect(labelsFor('important')).toEqual(['INBOX', 'UNREAD'])
      expect(
        JSON.parse(
          (
            db.prepare('SELECT payload FROM action_queue ORDER BY id DESC LIMIT 1').get() as {
              payload: string
            }
          ).payload
        )
      ).toMatchObject({ add: [], remove: ['IMPORTANT'], actionKind: 'move' })
    } finally {
      db.close()
    }
  })

  it('does not queue or record a Move that changes no label or reminder', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Destination', 'Destination', 'user')"
      ).run(ACCOUNT)
      db.prepare("INSERT INTO threads (account_id, id, subject) VALUES (?, 'thread', 'Already there')").run(
        ACCOUNT
      )
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES (?, 'thread', 'Label_Destination')`
      ).run(ACCOUNT)
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES (?, 'message', 'thread', '["Label_Destination"]')`
      ).run(ACCOUNT)

      expect(
        performTriage(db, ACCOUNT, {
          kind: 'move',
          threadIds: ['thread'],
          destination: { kind: 'label', labelId: 'Label_Destination' },
          sourceLabelId: null
        })
      ).toEqual({ label: 'Already there' })
      expect(pendingActionCount(db, ACCOUNT)).toBe(0)
      expect(undoLast(db, ACCOUNT)).toBeNull()
    } finally {
      db.close()
    }
  })

  it('applies a destination to every message when it was only partially present', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Destination', 'Destination', 'user')"
      ).run(ACCOUNT)
      db.prepare("INSERT INTO threads (account_id, id, subject) VALUES (?, 'thread', 'Mixed labels')").run(
        ACCOUNT
      )
      const insertMessage = db.prepare(
        'INSERT INTO messages (account_id, id, thread_id, labels_json) VALUES (?, ?, ?, ?)'
      )
      insertMessage.run(ACCOUNT, 'message-1', 'thread', JSON.stringify(['INBOX', 'Label_Destination']))
      insertMessage.run(ACCOUNT, 'message-2', 'thread', JSON.stringify(['INBOX']))
      const insertThreadLabel = db.prepare(
        'INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
      )
      insertThreadLabel.run(ACCOUNT, 'thread', 'INBOX')
      insertThreadLabel.run(ACCOUNT, 'thread', 'Label_Destination')

      expect(
        performTriage(db, ACCOUNT, {
          kind: 'move',
          threadIds: ['thread'],
          destination: { kind: 'label', labelId: 'Label_Destination' },
          sourceLabelId: null
        })
      ).toEqual({ label: 'Moved' })

      const messageLabels = (): string[][] =>
        (
          db
            .prepare('SELECT labels_json FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY id')
            .all(ACCOUNT, 'thread') as Array<{ labels_json: string }>
        ).map((row) => JSON.parse(row.labels_json) as string[])
      expect(messageLabels()).toEqual([['Label_Destination'], ['Label_Destination']])
      expect(
        JSON.parse((db.prepare('SELECT payload FROM action_queue').get() as { payload: string }).payload)
      ).toMatchObject({ add: ['Label_Destination'], remove: ['INBOX'] })

      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid moved' })
      expect(messageLabels()).toEqual([
        ['Label_Destination', 'INBOX'],
        ['Label_Destination', 'INBOX']
      ])
      expect(
        JSON.parse(
          (
            db.prepare('SELECT payload FROM action_queue ORDER BY id DESC LIMIT 1').get() as {
              payload: string
            }
          ).payload
        )
      ).toMatchObject({ add: ['INBOX'], remove: [], revertsQueueId: 1 })
    } finally {
      db.close()
    }
  })

  it('counts only changed targets in mixed bulk Move copy', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Destination', 'Destination', 'user')"
      ).run(ACCOUNT)
      const insertThread = db.prepare('INSERT INTO threads (account_id, id, subject) VALUES (?, ?, ?)')
      const insertMessage = db.prepare(
        'INSERT INTO messages (account_id, id, thread_id, labels_json) VALUES (?, ?, ?, ?)'
      )
      const insertThreadLabel = db.prepare(
        'INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
      )
      insertThread.run(ACCOUNT, 'changed', 'Changed')
      insertMessage.run(ACCOUNT, 'changed-message', 'changed', JSON.stringify(['INBOX']))
      insertThreadLabel.run(ACCOUNT, 'changed', 'INBOX')
      insertThread.run(ACCOUNT, 'unchanged', 'Unchanged')
      insertMessage.run(ACCOUNT, 'unchanged-message', 'unchanged', JSON.stringify(['Label_Destination']))
      insertThreadLabel.run(ACCOUNT, 'unchanged', 'Label_Destination')

      expect(
        performTriage(db, ACCOUNT, {
          kind: 'move',
          threadIds: ['changed', 'unchanged'],
          destination: { kind: 'label', labelId: 'Label_Destination' },
          sourceLabelId: null
        })
      ).toEqual({ label: 'Moved' })
      expect(pendingActionCount(db, ACCOUNT)).toBe(1)
      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid moved' })
    } finally {
      db.close()
    }
  })

  it('rejects missing, system, and identical Move labels before writing', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_User', 'User', 'user')"
      ).run(ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'STARRED', 'Starred', 'system')"
      ).run(ACCOUNT)
      const action = {
        kind: 'move' as const,
        threadIds: ['thread'],
        destination: { kind: 'label' as const, labelId: 'missing' },
        sourceLabelId: null
      }
      expect(() => performTriage(db, ACCOUNT, action)).toThrow('Move label is unavailable')
      expect(() =>
        performTriage(db, ACCOUNT, {
          ...action,
          destination: { kind: 'label', labelId: 'STARRED' }
        })
      ).toThrow('Move label is unavailable')
      expect(() =>
        performTriage(db, ACCOUNT, {
          ...action,
          destination: { kind: 'label', labelId: 'Label_User' },
          sourceLabelId: 'Label_User'
        })
      ).toThrow('Move source and destination must differ')
      expect(pendingActionCount(db, ACCOUNT)).toBe(0)
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
