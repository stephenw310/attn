import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TriageAction } from '../../shared/actions'
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
  snoozeThreads,
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
      expect(
        db.prepare('SELECT kind FROM action_queue ORDER BY id LIMIT 1').get() as { kind: string }
      ).toEqual({ kind: 'modifyLabels' })

      performTriage(db, ACCOUNT, { kind: 'untrash', threadIds: ['thread'] }, false)
      expect(mailboxIds('allMail')).toEqual(['thread'])
      expect(mailboxIds('trash')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('shares Spam and Trash queue operations with Move and restores direct-action pre-state exactly', () => {
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
      for (const threadId of ['direct-trash', 'move-trash']) {
        insertThread.run(ACCOUNT, threadId, threadId)
        insertMessage.run(ACCOUNT, `${threadId}-message`, threadId, JSON.stringify(['SPAM', 'STARRED']))
        insertThreadLabel.run(ACCOUNT, threadId, 'SPAM')
        insertThreadLabel.run(ACCOUNT, threadId, 'STARRED')
      }
      for (const threadId of ['direct-spam', 'move-spam']) {
        insertThread.run(ACCOUNT, threadId, threadId)
        insertMessage.run(ACCOUNT, `${threadId}-message`, threadId, JSON.stringify(['TRASH', 'STARRED']))
        insertThreadLabel.run(ACCOUNT, threadId, 'TRASH')
        insertThreadLabel.run(ACCOUNT, threadId, 'STARRED')
      }
      db.prepare(
        `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
         VALUES (?, 'direct-trash', 'snooze', 1234, 'pending')`
      ).run(ACCOUNT)

      expect(performTriage(db, ACCOUNT, { kind: 'trash', threadIds: ['direct-trash'] })).toEqual({
        label: 'Trashed'
      })
      performTriage(
        db,
        ACCOUNT,
        {
          kind: 'move',
          threadIds: ['move-trash'],
          destination: { kind: 'trash' },
          sourceLabelId: null
        },
        false
      )
      performTriage(db, ACCOUNT, { kind: 'spam', threadIds: ['direct-spam'] }, false)
      performTriage(
        db,
        ACCOUNT,
        {
          kind: 'move',
          threadIds: ['move-spam'],
          destination: { kind: 'spam' },
          sourceLabelId: null
        },
        false
      )

      const queued = db.prepare('SELECT kind, payload FROM action_queue ORDER BY id').all() as Array<{
        kind: string
        payload: string
      }>
      expect(queued.map((row) => row.kind)).toEqual([
        'modifyLabels',
        'modifyLabels',
        'modifyLabels',
        'modifyLabels'
      ])
      expect(queued.map((row) => JSON.parse(row.payload))).toEqual([
        expect.objectContaining({ add: ['TRASH'], remove: ['SPAM'], actionKind: 'trash' }),
        expect.objectContaining({ add: ['TRASH'], remove: ['SPAM'], actionKind: 'move' }),
        expect.objectContaining({ add: ['SPAM'], remove: ['TRASH'], actionKind: 'spam' }),
        expect.objectContaining({ add: ['SPAM'], remove: ['TRASH'], actionKind: 'move' })
      ])
      expect(
        db
          .prepare("SELECT state FROM reminders WHERE account_id = ? AND thread_id = 'direct-trash'")
          .get(ACCOUNT)
      ).toEqual({ state: 'canceled' })

      const labelsFor = (threadId: string): string[] =>
        (
          db
            .prepare(
              'SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id'
            )
            .all(ACCOUNT, threadId) as Array<{ label_id: string }>
        ).map((row) => row.label_id)
      expect(labelsFor('direct-trash')).toEqual(['STARRED', 'TRASH'])
      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid trashed' })
      expect(labelsFor('direct-trash')).toEqual(['SPAM', 'STARRED'])
      expect(
        db
          .prepare(
            "SELECT due_at AS dueAt, state FROM reminders WHERE account_id = ? AND thread_id = 'direct-trash'"
          )
          .get(ACCOUNT)
      ).toEqual({ dueAt: 1234, state: 'pending' })
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

  it('applies a partial destination to every message and reverses the thread mutation on undo', () => {
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
      expect(messageLabels()).toEqual([['INBOX'], ['INBOX']])
      expect(
        JSON.parse(
          (
            db.prepare('SELECT payload FROM action_queue ORDER BY id DESC LIMIT 1').get() as {
              payload: string
            }
          ).payload
        )
      ).toMatchObject({ add: ['INBOX'], remove: ['Label_Destination'], revertsQueueId: 1 })
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

  it('does not queue, undo, or claim an archive of a thread that never carried INBOX', () => {
    // triage.archive is offered in search and All Mail (useInboxCommands), so
    // the target can already be out of the inbox. Undoing must not file it.
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare("INSERT INTO threads (account_id, id, subject) VALUES (?, 'filed', 'Filed')").run(ACCOUNT)
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES (?, 'filed-message', 'filed', '["Label_Keep"]')`
      ).run(ACCOUNT)
      db.prepare(
        "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, 'filed', 'Label_Keep')"
      ).run(ACCOUNT)

      expect(performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['filed'] })).toEqual({
        label: 'Already there'
      })
      expect(pendingActionCount(db, ACCOUNT)).toBe(0)
      expect(undoLast(db, ACCOUNT)).toBeNull()
      expect(
        db
          .prepare('SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ?')
          .all(ACCOUNT, 'filed')
      ).toEqual([{ label_id: 'Label_Keep' }])
    } finally {
      db.close()
    }
  })

  it('links a label undo to the queue row it reverts so a rejected action can drop it', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
      db.prepare("INSERT INTO threads (account_id, id, subject) VALUES (?, 'thread', 'Roadmap')").run(ACCOUNT)
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES (?, 'message', 'thread', '["INBOX"]')`
      ).run(ACCOUNT)
      db.prepare(
        "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, 'thread', 'INBOX')"
      ).run(ACCOUNT)

      expect(performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['thread'] })).toEqual({
        label: 'Archived'
      })
      expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid archived' })
      const payloads = (
        db.prepare('SELECT payload FROM action_queue ORDER BY id').all() as Array<{ payload: string }>
      ).map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      expect(payloads).toEqual([
        expect.objectContaining({ add: [], remove: ['INBOX'], actionKind: 'archive' }),
        expect.objectContaining({ add: ['INBOX'], remove: [], actionKind: 'undo', revertsQueueId: 1 })
      ])
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

describe('follow-up triage matrix (T35/F9)', () => {
  function followUpDb(state: 'pending' | 'returned', dueAt: number, threadId = 't-f'): Db {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
    db.prepare('INSERT INTO threads (account_id, id) VALUES (?, ?)').run(ACCOUNT, threadId)
    db.prepare('INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)').run(
      ACCOUNT,
      threadId,
      'INBOX'
    )
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
         origin_message_id, origin_rfc_message_id, origin_internal_date)
       VALUES (?, ?, 'follow_up', ?, ?, 'm-origin', '<o@x>', 1)`
    ).run(ACCOUNT, threadId, dueAt, state)
    return db
  }

  function followUpState(db: Db, threadId = 't-f'): string | undefined {
    return (
      db
        .prepare("SELECT state FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'")
        .get(ACCOUNT, threadId) as { state: string } | undefined
    )?.state
  }

  it('archive completes a returned follow-up', () => {
    const db = followUpDb('returned', 1)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] }, false)
    expect(followUpState(db)).toBe('done')
  })

  it('archive cancels an overdue pending follow-up so the return cannot reverse it', () => {
    const db = followUpDb('pending', Date.now() - 1_000)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] }, false)
    expect(followUpState(db)).toBe('canceled')
  })

  it('a future follow-up survives ordinary archive', () => {
    const db = followUpDb('pending', Date.now() + 60_000)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] }, false)
    expect(followUpState(db)).toBe('pending')
  })

  it('trash and spam cancel a follow-up before it is due', () => {
    for (const kind of ['trash', 'spam'] as const) {
      const db = followUpDb('pending', Date.now() + 60_000)
      performTriage(db, ACCOUNT, { kind, threadIds: ['t-f'] }, false)
      expect(followUpState(db)).toBe('canceled')
    }
  })

  it('marking read or starring leaves the returned chip in place — reading is not answering', () => {
    const actions: TriageAction[] = [
      { kind: 'markUnread', threadIds: ['t-f'], on: false },
      { kind: 'star', threadIds: ['t-f'], on: true }
    ]
    for (const action of actions) {
      const db = followUpDb('returned', 1)
      performTriage(db, ACCOUNT, action, false)
      expect(followUpState(db)).toBe('returned')
    }
  })

  it('snoozing a returned follow-up makes it pending until the snooze returns', () => {
    const db = followUpDb('returned', 1)
    snoozeThreads(db, ACCOUNT, ['t-f'], Date.now() + 60_000)
    expect(followUpState(db)).toBe('pending')
  })

  it('undoing a trash restores the follow-up snapshot with the labels', () => {
    const db = followUpDb('returned', 1)
    performTriage(db, ACCOUNT, { kind: 'trash', threadIds: ['t-f'] })
    expect(followUpState(db)).toBe('done')
    undoLast(db, ACCOUNT)
    expect(followUpState(db)).toBe('returned')
    expect(
      db
        .prepare(
          "SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = 't-f' AND label_id = 'INBOX'"
        )
        .get(ACCOUNT)
    ).toBeDefined()
  })

  it('undoing an archive restores the follow-up snapshot with the labels', () => {
    // Archive undoes through apply(restoreInbox), not applyMoveUndo, so the
    // undo entry itself must carry the settled snapshot back (PR #101 review).
    const db = followUpDb('returned', 1)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] })
    expect(followUpState(db)).toBe('done')
    undoLast(db, ACCOUNT)
    expect(followUpState(db)).toBe('returned')
    expect(
      db
        .prepare(
          "SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = 't-f' AND label_id = 'INBOX'"
        )
        .get(ACCOUNT)
    ).toBeDefined()
  })

  it('undoing an archive revives an overdue pending follow-up it canceled', () => {
    const dueAt = Date.now() - 1_000
    const db = followUpDb('pending', dueAt)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] })
    expect(followUpState(db)).toBe('canceled')
    undoLast(db, ACCOUNT)
    expect(followUpState(db)).toBe('pending')
  })

  it('undoing an older move preserves a follow-up created by a later send', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
    db.prepare(
      "INSERT INTO threads (account_id, id, is_inbox_visible) VALUES (?, 't-later-follow-up', 1)"
    ).run(ACCOUNT)
    db.prepare(
      "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, 't-later-follow-up', 'INBOX')"
    ).run(ACCOUNT)
    performTriage(db, ACCOUNT, {
      kind: 'move',
      threadIds: ['t-later-follow-up'],
      destination: { kind: 'done' },
      sourceLabelId: null
    })

    db.prepare(
      `INSERT INTO outbox (id, account_id, state, thread_id, created_at, updated_at)
       VALUES ('sent-later', ?, 'sent', 't-later-follow-up', 200, 200)`
    ).run(ACCOUNT)
    recordOutboxSendUndo(ACCOUNT, 'sent-later')
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
         origin_message_id, origin_rfc_message_id, origin_internal_date, origin_outbox_created_at)
       VALUES (?, 't-later-follow-up', 'follow_up', 9999, 'pending',
         'm-later', '<later@test>', 200, 200)`
    ).run(ACCOUNT)

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Already sent' })
    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid moved' })
    expect(
      db
        .prepare(
          `SELECT state, origin_message_id AS origin FROM reminders
           WHERE account_id = ? AND thread_id = 't-later-follow-up' AND kind = 'follow_up'`
        )
        .get(ACCOUNT)
    ).toEqual({ state: 'pending', origin: 'm-later' })
  })

  it('undoing an older archive preserves a replacement follow-up from a later send', () => {
    const db = followUpDb('returned', 1)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] })
    expect(followUpState(db)).toBe('done')
    db.prepare(
      `INSERT INTO outbox (id, account_id, state, thread_id, created_at, updated_at)
       VALUES ('sent-replacement', ?, 'sent', 't-f', 200, 200)`
    ).run(ACCOUNT)
    recordOutboxSendUndo(ACCOUNT, 'sent-replacement')
    db.prepare(
      `UPDATE reminders SET due_at = 9999, state = 'pending',
         origin_message_id = 'm-replacement', origin_rfc_message_id = '<replacement@test>',
         origin_internal_date = 200, origin_outbox_created_at = 200
       WHERE account_id = ? AND thread_id = 't-f' AND kind = 'follow_up'`
    ).run(ACCOUNT)

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Already sent' })
    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Undid archived' })
    expect(
      db
        .prepare(
          `SELECT state, origin_message_id AS origin FROM reminders
           WHERE account_id = ? AND thread_id = 't-f' AND kind = 'follow_up'`
        )
        .get(ACCOUNT)
    ).toEqual({ state: 'pending', origin: 'm-replacement' })
  })

  it('undoing an archive that also canceled a pending snooze restores both reminders', () => {
    const db = followUpDb('returned', 1)
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES (?, 't-f', 'snooze', ?, 'pending')`
    ).run(ACCOUNT, Date.now() + 60_000)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] })
    expect(followUpState(db)).toBe('done')
    undoLast(db, ACCOUNT)
    // The snoozeAt undo re-snoozes; the follow-up restore then lands the
    // exact pre-archive snapshot on top of the re-snooze's postpone rule.
    expect(followUpState(db)).toBe('returned')
    expect(
      (
        db
          .prepare(
            "SELECT state FROM reminders WHERE account_id = ? AND thread_id = 't-f' AND kind = 'snooze'"
          )
          .get(ACCOUNT) as { state: string } | undefined
      )?.state
    ).toBe('pending')
  })

  it('undo never resurrects a follow-up answered while it was archived or moved', () => {
    // A qualifying reply cached between the action and its undo answers the
    // reminder: the restored snapshot must immediately re-settle (returned →
    // done) instead of putting the chip back on an answered thread.
    const actions: TriageAction[] = [
      { kind: 'archive', threadIds: ['t-f'] },
      { kind: 'trash', threadIds: ['t-f'] }
    ]
    for (const action of actions) {
      const db = followUpDb('returned', 1)
      performTriage(db, ACCOUNT, action)
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json)
         VALUES (?, 'm-reply', 't-f', 2, '["INBOX"]')`
      ).run(ACCOUNT)
      undoLast(db, ACCOUNT)
      expect(followUpState(db)).toBe('done')
      clearUndo(ACCOUNT)
    }
  })

  it('moving back to the inbox leaves the follow-up alone — un-filing, like restoreInbox', () => {
    for (const verb of [undefined, 'markNotDone' as const]) {
      const db = followUpDb('returned', 1)
      db.prepare("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = 't-f'").run(ACCOUNT)
      performTriage(
        db,
        ACCOUNT,
        {
          kind: 'move',
          threadIds: ['t-f'],
          destination: { kind: 'inbox' },
          sourceLabelId: null,
          ...(verb ? { verb } : {})
        },
        false
      )
      expect(followUpState(db)).toBe('returned')
    }
  })

  it('a filing move still completes a returned follow-up', () => {
    const db = followUpDb('returned', 1)
    performTriage(
      db,
      ACCOUNT,
      { kind: 'move', threadIds: ['t-f'], destination: { kind: 'done' }, sourceLabelId: null },
      false
    )
    expect(followUpState(db)).toBe('done')
  })

  it('the queued payload carries the follow-up snapshot for Gmail-rejection recovery', () => {
    const db = followUpDb('returned', 1)
    performTriage(db, ACCOUNT, { kind: 'archive', threadIds: ['t-f'] }, false)
    const payloads = (db.prepare('SELECT payload FROM action_queue').all() as Array<{ payload: string }>).map(
      (row) => JSON.parse(row.payload) as Record<string, unknown>
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0].followUpBefore).toMatchObject({
      state: 'returned',
      originMessageId: 'm-origin',
      originRfcMessageId: '<o@x>',
      originInternalDate: 1
    })
  })
})
