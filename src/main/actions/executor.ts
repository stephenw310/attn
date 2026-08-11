import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'
import { executeIntent, type QueueIntent } from './execute'

interface QueueRow {
  id: number
  kind: QueueIntent['kind']
  thread_id: string
  payload: string
  attempts: number
}

export class ActionExecutor {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly db: Db,
    private readonly provider: () => MailProvider | null
  ) {
    db.prepare("UPDATE action_queue SET state = 'pending' WHERE state = 'inflight'").run()
  }

  trigger(): void {
    if (this.running) return
    void this.drain()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async drain(): Promise<void> {
    const provider = this.provider()
    if (!provider) return
    this.running = true
    let retryMs: number | null = null
    try {
      for (;;) {
        const row = this.db
          .prepare(
            "SELECT id, kind, thread_id, payload, attempts FROM action_queue WHERE state = 'pending' ORDER BY id LIMIT 1"
          )
          .get() as QueueRow | undefined
        if (!row) break
        this.db.prepare("UPDATE action_queue SET state = 'inflight' WHERE id = ?").run(row.id)
        try {
          const payload = JSON.parse(row.payload) as { add?: string[]; remove?: string[] }
          const intent: QueueIntent =
            row.kind === 'modifyLabels'
              ? {
                  kind: row.kind,
                  threadId: row.thread_id,
                  add: payload.add ?? [],
                  remove: payload.remove ?? []
                }
              : { kind: row.kind, threadId: row.thread_id }
          await executeIntent(provider, intent)
          this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
            continue
          }
          const permanent =
            error instanceof GmailApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          this.db
            .prepare(
              'UPDATE action_queue SET state = ?, attempts = attempts + 1, last_error = ? WHERE id = ?'
            )
            .run(
              permanent ? 'failed' : 'pending',
              error instanceof Error ? error.message : String(error),
              row.id
            )
          if (!permanent) retryMs = Math.min(60_000, row.attempts === 0 ? 5_000 : 30_000)
          break
        }
      }
    } finally {
      this.running = false
      if (retryMs !== null) this.timer = setTimeout(() => this.trigger(), retryMs)
    }
  }
}
