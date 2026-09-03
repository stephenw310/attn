import type { Db } from './db'
import { FOLLOW_UP_KIND, followUpRecoveryPending } from './followUps'
import { applyThreadDelta } from './store/mutate'
import { type SchedulerTime, systemTime, type TimerHandle } from './time'

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000

/**
 * Owns both reminder kinds (F4 snooze, F9 follow-up). A follow-up is eligible
 * to fire only once its origin is resolved, no history recovery is pending,
 * and no pending snooze hides the thread; a snooze return settles any overdue
 * follow-up with it in one transaction, with a single Inbox restoration.
 */
export class SnoozeScheduler {
  private timer: TimerHandle | null = null

  constructor(
    private readonly db: Db,
    private readonly getAccountId: () => string | null,
    private readonly onChanged: () => void,
    private readonly onQueueChanged: () => void,
    private readonly time: SchedulerTime = systemTime
  ) {}

  start(): void {
    this.refresh()
  }

  stop(): void {
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
  }

  refresh(): void {
    this.stop()
    const accountId = this.getAccountId()
    if (!accountId) return
    this.publish(this.returnDue(accountId))
    this.arm(accountId)
  }

  wakeThread(threadId: string): boolean {
    const accountId = this.getAccountId()
    if (!accountId) return false
    if (this.returnSnoozedThreads(accountId, [threadId]) === 0) return false
    // Re-arming shares this pass: anything else that came due is returned with
    // the woken thread and announced once, not twice.
    this.stop()
    this.returnDue(accountId)
    this.publish(true)
    this.arm(accountId)
    return true
  }

  private publish(changed: boolean): void {
    if (!changed) return
    this.onChanged()
    this.onQueueChanged()
  }

  private returnDue(accountId: string): boolean {
    const now = this.time.now()
    const snoozeRows = this.db
      .prepare(
        `SELECT thread_id FROM reminders
         WHERE account_id = ? AND kind = 'snooze' AND state = 'pending' AND due_at <= ?`
      )
      .all(accountId, now) as { thread_id: string }[]
    const snoozed = this.returnSnoozedThreads(
      accountId,
      snoozeRows.map((row) => row.thread_id)
    )
    // Standalone follow-up returns: due, origin resolved, not hidden behind a
    // pending snooze (that snooze's own return settles them, above), and not
    // deferred by history-expiry recovery.
    const followUpRows = followUpRecoveryPending(this.db, accountId)
      ? []
      : (this.db
          .prepare(
            `SELECT thread_id FROM reminders r
             WHERE r.account_id = ? AND r.kind = '${FOLLOW_UP_KIND}' AND r.state = 'pending'
               AND r.due_at <= ? AND r.origin_internal_date IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM reminders s
                               WHERE s.account_id = r.account_id AND s.thread_id = r.thread_id
                                 AND s.kind = 'snooze' AND s.state = 'pending')`
          )
          .all(accountId, now) as { thread_id: string }[])
    const followedUp = this.returnFollowUpThreads(
      accountId,
      followUpRows.map((row) => row.thread_id)
    )
    return snoozed + followedUp > 0
  }

  private returnSnoozedThreads(accountId: string, threadIds: string[]): number {
    if (threadIds.length === 0) return 0
    const now = this.time.now()
    const markReturned = this.db.prepare(
      `UPDATE reminders SET state = 'returned'
       WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'pending'`
    )
    // An overdue resolved follow-up was waiting only for this snooze: settle
    // both in the same transaction with one Inbox restoration, so a sync
    // refresh between the two cannot hide the returned thread (F9).
    const markFollowUpReturned = followUpRecoveryPending(this.db, accountId)
      ? null
      : this.db.prepare(
          `UPDATE reminders SET state = 'returned'
           WHERE account_id = ? AND thread_id = ? AND kind = '${FOLLOW_UP_KIND}' AND state = 'pending'
             AND due_at <= ? AND origin_internal_date IS NOT NULL`
        )
    const enqueue = this.db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
       VALUES (?, 'modifyLabels', ?, ?, 'pending')`
    )
    let returned = 0
    this.db.transaction(() => {
      for (const threadId of threadIds) {
        if (markReturned.run(accountId, threadId).changes === 0) continue
        returned++
        markFollowUpReturned?.run(accountId, threadId, now)
        applyThreadDelta(this.db, accountId, { threadId, add: ['INBOX'], remove: [] })
        enqueue.run(
          accountId,
          threadId,
          JSON.stringify({ add: ['INBOX'], remove: [], actionKind: 'snoozeReturn' })
        )
      }
    })()
    return returned
  }

  private returnFollowUpThreads(accountId: string, threadIds: string[]): number {
    if (threadIds.length === 0) return 0
    const markReturned = this.db.prepare(
      `UPDATE reminders SET state = 'returned'
       WHERE account_id = ? AND thread_id = ? AND kind = '${FOLLOW_UP_KIND}' AND state = 'pending'`
    )
    const hasInbox = this.db.prepare(
      `SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'INBOX'`
    )
    const enqueue = this.db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
       VALUES (?, 'modifyLabels', ?, ?, 'pending')`
    )
    let returned = 0
    this.db.transaction(() => {
      for (const threadId of threadIds) {
        if (markReturned.run(accountId, threadId).changes === 0) continue
        returned++
        // A thread an earlier snooze already restored needs no second Inbox
        // mutation — the chip and priority flip on the reminder state alone.
        const alreadyInInbox = hasInbox.get(accountId, threadId) !== undefined
        applyThreadDelta(this.db, accountId, { threadId, add: ['INBOX'], remove: [] })
        if (!alreadyInInbox) {
          enqueue.run(
            accountId,
            threadId,
            JSON.stringify({ add: ['INBOX'], remove: [], actionKind: 'followUpReturn' })
          )
        }
      }
    })()
    return returned
  }

  private arm(accountId: string): void {
    const includeFollowUps = !followUpRecoveryPending(this.db, accountId)
    const next = this.db
      .prepare(
        `SELECT MIN(due) AS due FROM (
           SELECT due_at AS due FROM reminders
           WHERE account_id = ? AND kind = 'snooze' AND state = 'pending'
           UNION ALL
           SELECT due_at AS due FROM reminders r
           WHERE ? AND r.account_id = ? AND r.kind = '${FOLLOW_UP_KIND}' AND r.state = 'pending'
             AND r.origin_internal_date IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM reminders s
                             WHERE s.account_id = r.account_id AND s.thread_id = r.thread_id
                               AND s.kind = 'snooze' AND s.state = 'pending')
         )`
      )
      .get(accountId, includeFollowUps ? 1 : 0, accountId) as { due: number | null } | undefined
    if (next?.due == null) return
    const delay = Math.min(Math.max(next.due - this.time.now(), 0), MAX_TIMER_DELAY_MS)
    this.timer = this.time.timers.setTimeout(() => this.refresh(), delay)
  }
}
