import type { Db } from './db'
import { applyThreadDelta } from './store/mutate'

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000

export class SnoozeScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly db: Db,
    private readonly getAccountId: () => string | null,
    private readonly onChanged: () => void,
    private readonly onQueueChanged: () => void
  ) {}

  start(): void {
    this.refresh()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  refresh(): void {
    this.stop()
    const accountId = this.getAccountId()
    if (!accountId) return
    const returned = this.returnDue(accountId)
    if (returned) {
      this.onChanged()
      this.onQueueChanged()
    }
    this.arm(accountId)
  }

  wakeThread(threadId: string): boolean {
    const accountId = this.getAccountId()
    if (!accountId) return false
    const returned = this.returnThreads(accountId, [threadId]) > 0
    if (returned) {
      this.onChanged()
      this.onQueueChanged()
      this.refresh()
    }
    return returned
  }

  private returnDue(accountId: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT thread_id FROM reminders
         WHERE account_id = ? AND kind = 'snooze' AND state = 'pending' AND due_at <= ?`
      )
      .all(accountId, Date.now()) as { thread_id: string }[]
    return (
      this.returnThreads(
        accountId,
        rows.map((row) => row.thread_id)
      ) > 0
    )
  }

  private returnThreads(accountId: string, threadIds: string[]): number {
    if (threadIds.length === 0) return 0
    const markReturned = this.db.prepare(
      `UPDATE reminders SET state = 'returned'
       WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'pending'`
    )
    const enqueue = this.db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state, created_at)
       VALUES (?, 'modifyLabels', ?, ?, 'pending', ?)`
    )
    let returned = 0
    this.db.transaction(() => {
      for (const threadId of threadIds) {
        if (markReturned.run(accountId, threadId).changes === 0) continue
        returned++
        applyThreadDelta(this.db, accountId, { threadId, add: ['INBOX'], remove: [] })
        enqueue.run(accountId, threadId, JSON.stringify({ add: ['INBOX'], remove: [] }), Date.now())
      }
    })()
    return returned
  }

  private arm(accountId: string): void {
    const next = this.db
      .prepare(
        `SELECT due_at FROM reminders
         WHERE account_id = ? AND kind = 'snooze' AND state = 'pending'
         ORDER BY due_at ASC LIMIT 1`
      )
      .get(accountId) as { due_at: number } | undefined
    if (!next) return
    const delay = Math.min(Math.max(next.due_at - Date.now(), 0), MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => this.refresh(), delay)
  }
}
