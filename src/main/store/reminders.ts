import type { Db } from '../db'
import { applyThreadDelta } from './mutate'

export type SnoozeReminderState = 'pending' | 'returned' | 'done' | 'canceled'

export interface SnoozeReminderSnapshot {
  dueAt: number
  state: SnoozeReminderState
}

export function snoozeReminderSnapshot(
  db: Db,
  accountId: string,
  threadId: string
): SnoozeReminderSnapshot | null {
  const row = db
    .prepare(
      `SELECT due_at AS dueAt, state FROM reminders
       WHERE account_id = ? AND thread_id = ? AND kind = 'snooze'`
    )
    .get(accountId, threadId) as SnoozeReminderSnapshot | undefined
  return row ?? null
}

export function restoreSnoozeReminder(
  db: Db,
  accountId: string,
  threadId: string,
  snapshot: SnoozeReminderSnapshot | null
): void {
  if (!snapshot) {
    db.prepare("DELETE FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'snooze'").run(
      accountId,
      threadId
    )
    return
  }
  db.prepare(
    `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
     VALUES (?, ?, 'snooze', ?, ?)
     ON CONFLICT(account_id, thread_id, kind) DO UPDATE SET
       due_at = excluded.due_at, state = excluded.state`
  ).run(accountId, threadId, snapshot.dueAt, snapshot.state)
}

/** Local-only snooze state is authoritative over a fresh Gmail label snapshot. */
export function replaySnoozeReminderDelta(db: Db, accountId: string, threadId: string): void {
  const snapshot = snoozeReminderSnapshot(db, accountId, threadId)
  if (snapshot?.state === 'pending') {
    applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
  } else if (snapshot?.state === 'returned') {
    applyThreadDelta(db, accountId, { threadId, add: ['INBOX'], remove: [] })
  }
}
