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

/**
 * Follow-up rows (T35/F9) share the reminders table under kind 'follow_up';
 * the origin columns identify the sent message a canceling reply must
 * postdate, independently of outbox retention.
 */
export interface FollowUpReminderSnapshot extends SnoozeReminderSnapshot {
  originMessageId: string | null
  originRfcMessageId: string | null
  originInternalDate: number | null
  originOutboxCreatedAt: number | null
}

export function followUpReminderSnapshot(
  db: Db,
  accountId: string,
  threadId: string
): FollowUpReminderSnapshot | null {
  const row = db
    .prepare(
      `SELECT due_at AS dueAt, state, origin_message_id AS originMessageId,
              origin_rfc_message_id AS originRfcMessageId, origin_internal_date AS originInternalDate,
              origin_outbox_created_at AS originOutboxCreatedAt
       FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'`
    )
    .get(accountId, threadId) as FollowUpReminderSnapshot | undefined
  return row ?? null
}

export function restoreFollowUpReminder(
  db: Db,
  accountId: string,
  threadId: string,
  snapshot: FollowUpReminderSnapshot | null
): void {
  if (!snapshot) {
    db.prepare("DELETE FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'").run(
      accountId,
      threadId
    )
    return
  }
  db.prepare(
    `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
       origin_message_id, origin_rfc_message_id, origin_internal_date, origin_outbox_created_at)
     VALUES (?, ?, 'follow_up', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_id, kind) DO UPDATE SET
       due_at = excluded.due_at, state = excluded.state,
       origin_message_id = excluded.origin_message_id,
       origin_rfc_message_id = excluded.origin_rfc_message_id,
       origin_internal_date = excluded.origin_internal_date,
       origin_outbox_created_at = excluded.origin_outbox_created_at`
  ).run(
    accountId,
    threadId,
    snapshot.dueAt,
    snapshot.state,
    snapshot.originMessageId,
    snapshot.originRfcMessageId,
    snapshot.originInternalDate,
    snapshot.originOutboxCreatedAt
  )
}

/**
 * A *pending* snooze hides its thread until the reminder fires, and Gmail has no
 * concept of that (SPEC §9 #6), so local state wins over a fresh label snapshot.
 *
 * Only 'pending' qualifies. 'returned' is a display flag for the inbox badge and
 * is deliberately left set until the user handles the thread in Attn — treating
 * it as a label authority would re-add INBOX on every sync forever, overriding
 * an archive the user performed in Gmail and inverting SPEC F2's conflict rule.
 * A snooze return that Gmail rejects is repaired once, by the executor.
 */
export function replaySnoozeReminderDelta(db: Db, accountId: string, threadId: string): void {
  if (snoozeReminderSnapshot(db, accountId, threadId)?.state !== 'pending') return
  applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
}
