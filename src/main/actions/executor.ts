import type { RevertedAction } from '../../shared/actionRevert'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { deleteThread, persistThread } from '../sync/persist'
import type { GetThreadOptions, MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { invalidateRevertedUndo } from '.'
import {
  classifyActionError,
  executeIntent,
  isStoredAuthActionError,
  type QueueIntent,
  retryDelayMs
} from './execute'
import { decodeLabelDelta } from './queuePayload'
import { queueIntentRef, revertedAction } from './revert'

export interface ActionRecoveryProvider extends MailActionProvider {
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
}

interface QueueRow {
  id: number
  kind: QueueIntent['kind']
  thread_id: string
  payload: string
  attempts: number
  subject?: string
}

interface FailedAuthRow {
  id: number
  last_error: string | null
}

export class ActionExecutor {
  private drainPromise: Promise<void> | null = null
  private stopping = false
  private timer: TimerHandle | null = null

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => ActionRecoveryProvider | null,
    private readonly notify: () => void = () => {},
    private readonly notifyReverted: (actions: RevertedAction[]) => void = () => {},
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

  /** Requeue rows stranded by the pre-T18 hard-401 behavior after fresh auth succeeds. */
  resumeAuthFailures(accountId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, last_error FROM action_queue
         WHERE account_id = ? AND state = 'failed'`
      )
      .all(accountId) as FailedAuthRow[]
    const resume = this.db.prepare("UPDATE action_queue SET state = 'pending' WHERE id = ?")
    let resumed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (!isStoredAuthActionError(row.last_error)) continue
        resumed += resume.run(row.id).changes
      }
    })()
    if (resumed > 0) this.notify()
    return resumed
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) return
    if (this.resumeLegacyPermanentFailures(accountId) > 0) this.notify()
    let retryMs: number | null = null
    const reverted: RevertedAction[] = []
    try {
      for (;;) {
        if (this.stopping || this.accountId() !== accountId) break
        const row = this.db
          .prepare(
            `SELECT aq.id, aq.kind, aq.thread_id, aq.payload, aq.attempts, t.subject
             FROM action_queue aq
             LEFT JOIN threads t ON t.account_id = aq.account_id AND t.id = aq.thread_id
             WHERE aq.account_id = ? AND aq.state = 'pending' ORDER BY aq.id LIMIT 1`
          )
          .get(accountId) as QueueRow | undefined
        if (!row) break
        this.db.prepare("UPDATE action_queue SET state = 'inflight' WHERE id = ?").run(row.id)
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
        try {
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
          const errorKind = classifyActionError(error)
          if (errorKind === 'permanent') {
            try {
              const snapshot = await provider.getThread(row.thread_id, { format: 'full' })
              if (this.stopping || this.accountId() !== accountId) break
              this.db.transaction(() => {
                this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
                persistThread(this.db, accountId, snapshot)
              })()
              invalidateRevertedUndo(accountId, [queueIntentRef(intent)])
              const returnedToInbox = (snapshot.messages ?? []).some((message) =>
                message.labelIds?.includes('INBOX')
              )
              reverted.push(revertedAction(intent, row.subject ?? '', returnedToInbox))
              this.notify()
              continue
            } catch (recoveryError) {
              if (this.stopping) break
              if (recoveryError instanceof GmailApiError && recoveryError.status === 404) {
                this.db.transaction(() => {
                  this.db.prepare('DELETE FROM action_queue WHERE id = ?').run(row.id)
                  deleteThread(this.db, accountId, row.thread_id)
                })()
                invalidateRevertedUndo(accountId, [queueIntentRef(intent)])
                reverted.push(revertedAction(intent, row.subject ?? '', false))
                this.notify()
                continue
              }
              this.markPending(row, recoveryError)
              this.notify()
              retryMs = retryDelayMs(row.attempts)
              break
            }
          }
          this.db
            .prepare(
              'UPDATE action_queue SET state = ?, attempts = attempts + 1, last_error = ? WHERE id = ?'
            )
            .run('pending', error instanceof Error ? error.message : String(error), row.id)
          this.notify()
          if (errorKind === 'auth') break
          retryMs = retryDelayMs(row.attempts)
          break
        }
      }
    } finally {
      if (reverted.length > 0) this.notifyReverted(reverted)
      if (!this.stopping && retryMs !== null) {
        this.timer = this.time.timers.setTimeout(() => {
          this.timer = null
          void this.trigger()
        }, retryMs)
      }
    }
  }

  private markPending(row: QueueRow, error: unknown): void {
    this.db
      .prepare(
        "UPDATE action_queue SET state = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?"
      )
      .run(error instanceof Error ? error.message : String(error), row.id)
  }

  private resumeLegacyPermanentFailures(accountId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, last_error FROM action_queue
         WHERE account_id = ? AND state = 'failed'`
      )
      .all(accountId) as FailedAuthRow[]
    const resume = this.db.prepare("UPDATE action_queue SET state = 'pending' WHERE id = ?")
    let resumed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (isStoredAuthActionError(row.last_error)) continue
        resumed += resume.run(row.id).changes
      }
    })()
    return resumed
  }
}
