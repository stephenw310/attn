import type { RevertedAction, RevertedActionKind } from '../../shared/actionRevert'
import type { Db } from '../db'
import { GracefulDrainer } from '../drain'
import type { GmailThread } from '../gmail/parse'
import { applyThreadDelta } from '../store/mutate'
import {
  type FollowUpReminderSnapshot,
  restoreFollowUpReminder,
  restoreSnoozeReminder,
  type SnoozeReminderSnapshot
} from '../store/reminders'
import { nonDraftMessages, persistThread } from '../sync/persist'
import type { GetThreadOptions, MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime } from '../time'
import { invalidateRevertedUndo } from '.'
import {
  classifyActionError,
  executeIntent,
  isStoredAuthActionError,
  type QueueIntent,
  retryDelayMs,
  storeActionError
} from './execute'
import { decodeLabelDelta } from './queuePayload'
import { queueRowRef, revertedAction, syntheticIntent, unavailableAction } from './revert'

export interface ActionRecoveryProvider extends MailActionProvider {
  getThread(id: string, options?: GetThreadOptions): Promise<GmailThread>
}

interface QueueRow {
  id: number
  thread_id: string
  payload: string
  attempts: number
  state: 'pending' | 'recovering'
  last_error: string | null
  subject?: string
}

interface DecodedQueueRow {
  intent: QueueIntent
  actionKind?: RevertedActionKind
  reminderBefore?: SnoozeReminderSnapshot | null
  followUpBefore?: FollowUpReminderSnapshot | null
}

type RecoveryOutcome =
  | { kind: 'continue' }
  | { kind: 'pause' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop' }

export interface ActionExecutorOptions {
  notify?: () => void
  notifyReverted?: (accountId: string, actions: RevertedAction[]) => void
  time?: SchedulerTime
}

export class ActionExecutor {
  private readonly drainer: GracefulDrainer
  private readonly notify: () => void
  private readonly notifyReverted: (accountId: string, actions: RevertedAction[]) => void

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => ActionRecoveryProvider | null,
    options: ActionExecutorOptions = {}
  ) {
    this.notify = options.notify ?? (() => {})
    this.notifyReverted = options.notifyReverted ?? (() => {})
    this.drainer = new GracefulDrainer(() => this.drain(), {
      time: options.time ?? systemTime,
      // Preserve the retry ladder when another subsystem nudges the executor:
      // only a switch to a different account may cut a pending backoff short.
      preemptTimer: (timerAccountId) => {
        const activeAccountId = this.accountId()
        return activeAccountId !== null && activeAccountId !== timerAccountId
      }
    })
    db.prepare("UPDATE action_queue SET state = 'pending' WHERE state = 'inflight'").run()
  }

  trigger(): Promise<void> {
    return this.drainer.trigger()
  }

  /** True only while user-action replay is actively using Gmail, not during retry backoff. */
  isRunning(): boolean {
    return this.drainer.isRunning()
  }

  stop(): void {
    this.drainer.halt()
  }

  /** Resume execution or recovery rows after fresh same-account authentication succeeds. */
  resumeAuthFailures(accountId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, last_error FROM action_queue
         WHERE account_id = ? AND state IN ('pending', 'recovering')`
      )
      .all(accountId) as Array<{ id: number; last_error: string | null }>
    const resume = this.db.prepare(
      'UPDATE action_queue SET attempts = 0, last_error = NULL WHERE account_id = ? AND id = ?'
    )
    let resumed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (!isStoredAuthActionError(row.last_error)) continue
        resumed += resume.run(accountId, row.id).changes
      }
    })()
    if (resumed > 0) this.notify()
    return resumed
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) return
    let retryMs: number | null = null
    const reverted: RevertedAction[] = []
    try {
      for (;;) {
        if (this.drainer.isStopping() || this.accountId() !== accountId) break
        const row = this.db
          .prepare(
            `SELECT aq.id, aq.thread_id, aq.payload, aq.attempts, aq.state,
                    aq.last_error, t.subject
             FROM action_queue aq
             LEFT JOIN threads t ON t.account_id = aq.account_id AND t.id = aq.thread_id
             WHERE aq.account_id = ? AND aq.state IN ('pending', 'recovering')
             ORDER BY aq.id LIMIT 1`
          )
          .get(accountId) as QueueRow | undefined
        if (!row) break
        // A hard 401 is deliberately inert until a successful same-account
        // sign-in clears its stored marker through resumeAuthFailures().
        if (isStoredAuthActionError(row.last_error)) break
        let decoded: DecodedQueueRow
        try {
          decoded = this.decodeRow(row)
        } catch (error) {
          // A malformed local payload cannot be sent safely, but it must not
          // poison the queue. Recover the thread from Gmail without replaying
          // or trying to infer the corrupt mutation.
          if (row.state === 'pending') this.markRecovering(row, accountId, error, 'permanent')
          const outcome = await this.recover(
            row,
            accountId,
            provider,
            null,
            'labels',
            undefined,
            undefined,
            reverted
          )
          if (outcome.kind === 'continue') continue
          if (outcome.kind === 'retry') retryMs = outcome.delayMs
          break
        }
        const { intent, actionKind, reminderBefore, followUpBefore } = decoded
        if (row.state === 'recovering') {
          const outcome = await this.recover(
            row,
            accountId,
            provider,
            intent,
            actionKind,
            reminderBefore,
            followUpBefore,
            reverted
          )
          if (outcome.kind === 'continue') continue
          if (outcome.kind === 'retry') retryMs = outcome.delayMs
          break
        }
        const claimed = this.db
          .prepare(
            `UPDATE action_queue SET state = 'inflight'
             WHERE account_id = ? AND id = ? AND state = 'pending'`
          )
          .run(accountId, row.id).changes
        if (claimed === 0) continue
        try {
          await executeIntent(provider, intent)
          if (this.drainer.isStopping()) break
          this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
          this.notify()
        } catch (error) {
          if (this.drainer.isStopping()) break
          const errorKind = classifyActionError(error)
          if (errorKind === 'permanent') {
            this.markRecovering(row, accountId, error, errorKind)
            this.notify()
            const outcome = await this.recover(
              row,
              accountId,
              provider,
              intent,
              actionKind,
              reminderBefore,
              followUpBefore,
              reverted
            )
            if (outcome.kind === 'continue') continue
            if (outcome.kind === 'retry') retryMs = outcome.delayMs
            break
          }
          this.markPending(row, accountId, error, errorKind)
          this.notify()
          if (errorKind === 'auth') break
          retryMs = retryDelayMs(row.attempts)
          break
        }
      }
    } finally {
      if (reverted.length > 0) this.notifyReverted(accountId, reverted)
      if (!this.drainer.isStopping() && retryMs !== null && this.accountId() === accountId) {
        this.drainer.arm(retryMs, accountId)
      }
    }
  }

  private async recover(
    row: QueueRow,
    accountId: string,
    provider: ActionRecoveryProvider,
    intent: QueueIntent | null,
    actionKind: RevertedActionKind | undefined,
    reminderBefore: SnoozeReminderSnapshot | null | undefined,
    followUpBefore: FollowUpReminderSnapshot | null | undefined,
    reverted: RevertedAction[]
  ): Promise<RecoveryOutcome> {
    if (this.drainer.isStopping() || this.accountId() !== accountId) return { kind: 'stop' }
    let snapshot: GmailThread
    try {
      snapshot = await provider.getThread(row.thread_id, { format: 'full' })
    } catch (error) {
      if (this.drainer.isStopping() || this.accountId() !== accountId) return { kind: 'stop' }
      const errorKind = classifyActionError(error)
      if (errorKind === 'permanent') {
        this.finishUnrecoverable(row, accountId, actionKind, reverted)
        return { kind: 'continue' }
      }
      this.markRecovering(row, accountId, error, errorKind, true)
      this.notify()
      return errorKind === 'auth' ? { kind: 'pause' } : { kind: 'retry', delayMs: retryDelayMs(row.attempts) }
    }
    if (this.drainer.isStopping() || this.accountId() !== accountId) return { kind: 'stop' }
    const messages = nonDraftMessages(snapshot.messages ?? [])
    if (messages.length === 0) {
      this.finishUnrecoverable(row, accountId, actionKind, reverted)
      return { kind: 'continue' }
    }

    // Local persistence failures are not Gmail retry failures: no 60-second
    // network retry ladder and no row deletion. They also must not reject
    // drain() — every caller floats that promise — so the row simply stays
    // 'recovering' for the next drain and the fault is logged.
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
        this.dropQueuedReverts(accountId, row.id)
        if (reminderBefore !== undefined) {
          restoreSnoozeReminder(this.db, accountId, row.thread_id, reminderBefore)
        }
        if (followUpBefore !== undefined) {
          restoreFollowUpReminder(this.db, accountId, row.thread_id, followUpBefore)
        }
        persistThread(this.db, accountId, snapshot)
        // An automatic snooze or follow-up return Gmail rejected is kept
        // visible locally, but only as this one repair. A standing override
        // would fight every later snapshot of the thread.
        if (actionKind === 'snoozeReturn' || actionKind === 'followUpReturn') {
          applyThreadDelta(this.db, accountId, { threadId: row.thread_id, add: ['INBOX'], remove: [] })
        }
      })()
    } catch (error) {
      console.error(
        `[actions] recovery persistence failed for thread ${row.thread_id}:`,
        error instanceof Error ? error.message : error
      )
      return { kind: 'stop' }
    }
    invalidateRevertedUndo(accountId, [queueRowRef(row.id, row.thread_id)])
    const returnedToInbox = this.threadHasInboxLabel(accountId, row.thread_id)
    reverted.push(
      revertedAction(
        intent ?? syntheticIntent(row.thread_id),
        row.subject ?? '',
        returnedToInbox,
        actionKind === 'snoozeReturn' || actionKind === 'followUpReturn' ? 'keptLocal' : 'restored',
        actionKind
      )
    )
    this.notify()
    return { kind: 'continue' }
  }

  private decodeRow(row: QueueRow): DecodedQueueRow {
    const payload = decodeLabelDelta(row.payload)
    return {
      intent: {
        kind: 'modifyLabels',
        threadId: row.thread_id,
        add: payload.add,
        remove: payload.remove
      },
      actionKind: payload.actionKind,
      reminderBefore: payload.reminderBefore,
      followUpBefore: payload.followUpBefore
    }
  }

  private threadHasInboxLabel(accountId: string, threadId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM thread_labels
           WHERE account_id = ? AND thread_id = ? AND label_id = 'INBOX'`
        )
        .get(accountId, threadId)
    )
  }

  private finishUnrecoverable(
    row: QueueRow,
    accountId: string,
    actionKind: RevertedActionKind | undefined,
    reverted: RevertedAction[]
  ): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
      this.dropQueuedReverts(accountId, row.id)
    })()
    invalidateRevertedUndo(accountId, [queueRowRef(row.id, row.thread_id)])
    reverted.push(unavailableAction(row.thread_id, row.subject ?? '', actionKind))
    this.notify()
  }

  private dropQueuedReverts(accountId: string, queueId: number): void {
    const candidates = this.db
      .prepare(
        `SELECT id, payload FROM action_queue
         WHERE account_id = ? AND state = 'pending' AND id > ?
         ORDER BY id`
      )
      .all(accountId, queueId) as Array<{ id: number; payload: string }>
    const remove = this.db.prepare(
      "DELETE FROM action_queue WHERE account_id = ? AND id = ? AND state = 'pending'"
    )
    for (const candidate of candidates) {
      try {
        if (decodeLabelDelta(candidate.payload).revertsQueueId === queueId) {
          remove.run(accountId, candidate.id)
        }
      } catch {
        // A corrupt later row gets its own authoritative recovery turn.
      }
    }
  }

  private markPending(
    row: QueueRow,
    accountId: string,
    error: unknown,
    errorKind: ReturnType<typeof classifyActionError>
  ): void {
    this.db
      .prepare(
        `UPDATE action_queue SET state = 'pending', attempts = attempts + 1, last_error = ?
         WHERE account_id = ? AND id = ?`
      )
      .run(storeActionError(error, errorKind), accountId, row.id)
  }

  private markRecovering(
    row: QueueRow,
    accountId: string,
    error: unknown,
    errorKind: ReturnType<typeof classifyActionError>,
    incrementAttempts = false
  ): void {
    this.db
      .prepare(
        `UPDATE action_queue
         SET state = 'recovering', attempts = attempts + ?, last_error = ?
         WHERE account_id = ? AND id = ?`
      )
      .run(incrementAttempts ? 1 : 0, storeActionError(error, errorKind), accountId, row.id)
  }
}
