import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { executeIntent, isPermanentActionError, type QueueIntent, retryDelayMs } from './execute'
import { decodeLabelDelta } from './queuePayload'

interface QueueRow {
  id: number
  kind: QueueIntent['kind']
  thread_id: string
  payload: string
  attempts: number
}

export class ActionExecutor {
  private drainPromise: Promise<void> | null = null
  private stopping = false
  private timer: TimerHandle | null = null

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailActionProvider | null,
    private readonly notify: () => void = () => {},
    private readonly time: SchedulerTime = systemTime
  ) {
    db.prepare("UPDATE action_queue SET state = 'pending' WHERE state = 'inflight'").run()
  }

  trigger(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    // Preserve the retry ladder when another subsystem nudges the executor.
    if (this.timer) return Promise.resolve()
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
  }

  stop(): void {
    this.stopping = true
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) return
    let retryMs: number | null = null
    try {
      for (;;) {
        if (this.stopping || this.accountId() !== accountId) break
        const row = this.db
          .prepare(
            `SELECT id, kind, thread_id, payload, attempts FROM action_queue
             WHERE account_id = ? AND state = 'pending' ORDER BY id LIMIT 1`
          )
          .get(accountId) as QueueRow | undefined
        if (!row) break
        this.db.prepare("UPDATE action_queue SET state = 'inflight' WHERE id = ?").run(row.id)
        try {
          const payload = decodeLabelDelta(row.payload)
          const intent: QueueIntent =
            row.kind === 'modifyLabels'
              ? {
                  kind: row.kind,
                  threadId: row.thread_id,
                  add: payload.add,
                  remove: payload.remove
                }
              : { kind: row.kind, threadId: row.thread_id }
          await executeIntent(provider, intent)
          if (this.stopping) break
          this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
          this.notify()
        } catch (error) {
          if (this.stopping) break
          if (error instanceof GmailApiError && error.status === 404) {
            this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
            this.notify()
            continue
          }
          const permanent = isPermanentActionError(error)
          this.db
            .prepare(
              'UPDATE action_queue SET state = ?, attempts = attempts + 1, last_error = ? WHERE id = ?'
            )
            .run(
              permanent ? 'failed' : 'pending',
              error instanceof Error ? error.message : String(error),
              row.id
            )
          this.notify()
          if (permanent) continue
          retryMs = retryDelayMs(row.attempts)
          break
        }
      }
    } finally {
      if (!this.stopping && retryMs !== null) {
        this.timer = this.time.timers.setTimeout(() => {
          this.timer = null
          void this.trigger()
        }, retryMs)
      }
    }
  }
}
