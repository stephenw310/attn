// Derived mailbox membership (`thread_mailboxes`). Like the FTS index, this is
// derived state over stored rows: every writer reconciles one thread inside the
// same transaction as the row change, so a count can never disagree with the
// list it summarizes.
//
// Only the views whose membership and ordering are thread-level live here.
// Spam and Trash are deliberately absent: their membership is message-level,
// their list projection is built from the messages carrying the label, and
// Gmail purges both at about 30 days, so the label index already bounds them.

import { MAILBOX_BACKFILL_BATCH_PAUSE_MS, MAILBOX_BACKFILL_BATCH_SIZE } from '../sync/tuning'
import { type SchedulerTime, systemTime } from '../time'
import type { Db } from './index'
import { allMailMembershipSql, labeledMailboxMembershipSql } from './queries'

/** Views served from `thread_mailboxes`. */
export const MATERIALIZED_MAILBOX_VIEWS = ['inbox', 'allMail', 'sent', 'starred'] as const

export type MaterializedMailboxView = (typeof MATERIALIZED_MAILBOX_VIEWS)[number]

/**
 * One row per (thread, view) the thread belongs to, from the same predicates the
 * list queries use. Written as delete-then-insert for one thread so a replayed
 * snapshot converges rather than accumulating.
 */
function membershipSql(threadPredicate: string): string {
  return `
    INSERT INTO thread_mailboxes (account_id, view, thread_id, sort_at)
    SELECT t.account_id, view.name, t.id, COALESCE(t.last_msg_at, 0)
    FROM threads t
    JOIN (SELECT 'inbox' AS name UNION ALL SELECT 'allMail'
          UNION ALL SELECT 'sent' UNION ALL SELECT 'starred') view
    WHERE t.account_id = @account_id AND ${threadPredicate}
      AND CASE view.name
        WHEN 'inbox' THEN
          t.is_inbox_visible = 1 AND EXISTS (
            SELECT 1 FROM thread_labels tl
            WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX'
          )
        WHEN 'allMail' THEN (${allMailMembershipSql()})
        WHEN 'sent' THEN
          EXISTS (
            SELECT 1 FROM thread_labels tl
            WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'SENT'
          ) AND (${labeledMailboxMembershipSql("'SENT'")})
        WHEN 'starred' THEN
          EXISTS (
            SELECT 1 FROM thread_labels tl
            WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'STARRED'
          ) AND (${labeledMailboxMembershipSql("'STARRED'")})
      END`
}

/**
 * Recompute one thread's rows. Callers already hold a transaction covering the
 * row change that made this stale; this never opens its own, so a failed write
 * cannot leave membership ahead of the mail it describes.
 */
export function refreshThreadMailboxes(db: Db, accountId: string, threadId: string): void {
  db.prepare('DELETE FROM thread_mailboxes WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
  db.prepare(membershipSql('t.id = @thread_id')).run({ account_id: accountId, thread_id: threadId })
}

export function removeThreadMailboxes(db: Db, accountId: string, threadId: string): void {
  db.prepare('DELETE FROM thread_mailboxes WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
}

export interface MailboxMembershipBackfillOptions {
  batchSize?: number
  batchPauseMs?: number
  time?: SchedulerTime
  /** Stops the pass between batches; a later run resumes from the stored cursor. */
  shouldContinue?: () => boolean
}

/**
 * Fill `thread_mailboxes` for rows that predate it — a manually upgraded profile.
 * A freshly synced store maintains membership inline in `persistThread`, so this
 * finishes on its first batch. Each batch commits its rows and its cursor
 * together, so a restart resumes from the last durable checkpoint rather than
 * recomputing the account.
 *
 * It pauses between batches because the utility process runs one synchronous
 * SQLite connection: an uninterrupted pass over millions of threads would hold
 * every renderer read behind it.
 */
export async function runMailboxMembershipBackfill(
  db: Db,
  accountId: string,
  options: MailboxMembershipBackfillOptions = {}
): Promise<{ threadsIndexed: number; complete: boolean }> {
  const time = options.time ?? systemTime
  const batchSize = options.batchSize ?? MAILBOX_BACKFILL_BATCH_SIZE
  const batchPauseMs = options.batchPauseMs ?? MAILBOX_BACKFILL_BATCH_PAUSE_MS
  const shouldContinue = options.shouldContinue ?? (() => true)
  // Unit and upgrade scenarios can hold threads without a sync_state row; the
  // cursor UPDATE below must never be a silent no-op.
  db.prepare('INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)').run(accountId)
  const stored = db.prepare('SELECT mailbox_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
    | { mailbox_cursor: string | null }
    | undefined
  if (stored?.mailbox_cursor === 'done') return { threadsIndexed: 0, complete: true }

  const selectBatch = db.prepare(
    `SELECT id FROM threads
     WHERE account_id = ? AND id > ?
     ORDER BY id
     LIMIT ?`
  )
  const checkpoint = db.prepare('UPDATE sync_state SET mailbox_cursor = ? WHERE account_id = ?')
  // Set-based per batch, not one recompute per thread: an upgraded profile can
  // hold millions of threads, and the predicates are the same either way.
  const clearBatch = db.prepare(
    'DELETE FROM thread_mailboxes WHERE account_id = ? AND thread_id > ? AND thread_id <= ?'
  )
  const fillBatch = db.prepare(membershipSql('t.id > @after AND t.id <= @until'))
  let after = stored?.mailbox_cursor ?? ''
  let threadsIndexed = 0

  for (;;) {
    if (!shouldContinue()) return { threadsIndexed, complete: false }
    const batch = (selectBatch.all(accountId, after, batchSize) as { id: string }[]).map((row) => row.id)
    if (batch.length === 0) break
    const until = batch[batch.length - 1]
    const from = after
    db.transaction(() => {
      clearBatch.run(accountId, from, until)
      fillBatch.run({ account_id: accountId, after: from, until })
      checkpoint.run(until, accountId)
    })()
    threadsIndexed += batch.length
    after = until
    if (batch.length < batchSize) break
    if (batchPauseMs > 0) {
      await new Promise<void>((resolve) => time.timers.setTimeout(resolve, batchPauseMs))
    }
  }

  checkpoint.run('done', accountId)
  return { threadsIndexed, complete: true }
}
