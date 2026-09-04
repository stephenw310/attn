import { afterEach, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from './db'
import { countSystemMailboxes } from './db/queries'
import { MAILBOX_BACKFILL_BATCH_PAUSE_MS, MAILBOX_BACKFILL_BATCH_SIZE } from './sync/tuning'
import { SyncController } from './syncController'

afterEach(() => vi.useRealTimers())

function upgradedMailbox(): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('account', 'a@b.test')
  const insertThread = db.prepare('INSERT INTO threads (account_id, id) VALUES (?, ?)')
  const insertLabel = db.prepare(
    "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, 'INBOX')"
  )
  db.transaction(() => {
    for (let index = 0; index <= MAILBOX_BACKFILL_BATCH_SIZE; index++) {
      const id = `thread-${String(index).padStart(6, '0')}`
      insertThread.run('account', id)
      insertLabel.run('account', id)
    }
  })()
  return db
}

function controllerFor(db: Db): SyncController {
  return new SyncController({
    db,
    currentAccountId: () => 'account',
    isSignedIn: () => true,
    isSeeded: () => false,
    makeProvider: () => null,
    isForeground: () => false,
    hasForegroundProviderWork: () => false,
    mailRevision: () => 0,
    broadcastState: () => {},
    broadcastMailChanged: () => {},
    getActionExecutor: () => null,
    getDraftMirrorExecutor: () => null,
    getOutboxSender: () => null,
    getSnoozeScheduler: () => null
  })
}

it('resumes mailbox membership after reauthentication cancels a paused batch', async () => {
  vi.useFakeTimers()
  const db = upgradedMailbox()
  const controller = controllerFor(db)
  try {
    controller.onSignIn()
    expect(countSystemMailboxes(db, 'account').inbox).toBe(MAILBOX_BACKFILL_BATCH_SIZE)
    controller.onSignIn()
    await vi.advanceTimersByTimeAsync(MAILBOX_BACKFILL_BATCH_PAUSE_MS * 2)

    expect(countSystemMailboxes(db, 'account').inbox).toBe(MAILBOX_BACKFILL_BATCH_SIZE + 1)
    expect(db.prepare('SELECT mailbox_cursor FROM sync_state WHERE account_id = ?').get('account')).toEqual({
      mailbox_cursor: 'done'
    })
  } finally {
    controller.stop()
    await vi.runAllTimersAsync()
    db.close()
  }
})

it('does not start a queued mailbox pass after shutdown', async () => {
  vi.useFakeTimers()
  const db = upgradedMailbox()
  const controller = controllerFor(db)
  try {
    controller.onSignIn()
    controller.onSignIn()
    controller.stop()
    await vi.runAllTimersAsync()

    expect(countSystemMailboxes(db, 'account').inbox).toBe(MAILBOX_BACKFILL_BATCH_SIZE)
    expect(db.prepare('SELECT mailbox_cursor FROM sync_state WHERE account_id = ?').get('account')).toEqual({
      mailbox_cursor: `thread-${String(MAILBOX_BACKFILL_BATCH_SIZE - 1).padStart(6, '0')}`
    })
  } finally {
    controller.stop()
    await vi.runAllTimersAsync()
    db.close()
  }
})
