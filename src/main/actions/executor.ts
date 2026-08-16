import type { RevertedAction } from '../../shared/actionRevert'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { deleteThread, nonDraftMessages, persistThread } from '../sync/persist'
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
  state: 'pending' | 'recovering'
  last_error: string | null
  subject?: string
}

interface FailedAuthRow {
  id: number
  state: 'pending' | 'recovering' | 'failed'
  last_error: string | null
}

type RecoveryOutcome =
  | { kind: 'continue' }
  | { kind: 'pause' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop' }

export class ActionExecutor {
  private drainPromise: Promise<void> | null = null
  private stopping = false
  private timer: TimerHandle | null = null
  private timerAccountId: string | null = null

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => ActionRecoveryProvider | null,
    private readonly notify: () => void = () => {},
    private readonly notifyReverted: (accountId: string, actions: RevertedAction[]) => void = () => {},
    private readonly time: SchedulerTime = systemTime
  ) {
    db.prepare("UPDATE action_queue SET state = 'pending' WHERE state = 'inflight'").run()
  }

  trigger(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    // Preserve the retry ladder when another subsystem nudges the executor.
    if (this.timer) {
      const activeAccountId = this.accountId()
      if (!activeAccountId || activeAccountId === this.timerAccountId) return Promise.resolve()
      this.time.timers.clearTimeout(this.timer)
      this.timer = null
      this.timerAccountId = null
    }
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
    this.timerAccountId = null
  }

  /** Resume execution or recovery rows after fresh same-account authentication succeeds. */
  resumeAuthFailures(accountId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, state, last_error FROM action_queue
         WHERE account_id = ? AND state IN ('pending', 'recovering', 'failed')`
      )
      .all(accountId) as FailedAuthRow[]
    const resume = this.db.prepare(
      `UPDATE action_queue SET state = ?, attempts = 0, last_error = NULL
       WHERE account_id = ? AND id = ?`
    )
    let resumed = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (!isStoredAuthActionError(row.last_error)) continue
        const nextState = row.state === 'failed' ? 'pending' : row.state
        resumed += resume.run(nextState, accountId, row.id).changes
      }
    })()
    if (resumed > 0) this.notify()
    return resumed
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) return
    if (this.prepareLegacyFailures(accountId) > 0) this.notify()
    let retryMs: number | null = null
    const reverted: RevertedAction[] = []
    try {
      for (;;) {
        if (this.stopping || this.accountId() !== accountId) break
        const row = this.db
          .prepare(
            `SELECT aq.id, aq.kind, aq.thread_id, aq.payload, aq.attempts, aq.state,
                    aq.last_error, t.subject
             FROM action_queue aq
             LEFT JOIN threads t ON t.account_id = aq.account_id AND t.id = aq.thread_id
             WHERE aq.account_id = ? AND aq.state IN ('pending', 'recovering')
             ORDER BY aq.id LIMIT 1`
          )
          .get(accountId) as QueueRow | undefined
        if (!row) break
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
        // A hard 401 is deliberately inert until a successful same-account
        // sign-in clears its stored marker through resumeAuthFailures().
        if (isStoredAuthActionError(row.last_error)) break
        if (row.state === 'recovering') {
          const outcome = await this.recover(row, accountId, provider, intent, reverted)
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
          if (this.stopping) break
          this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
          this.notify()
        } catch (error) {
          if (this.stopping) break
          if (error instanceof GmailApiError && error.status === 404) {
            this.db.transaction(() => {
              this.db
                .prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?')
                .run(accountId, row.id)
              deleteThread(this.db, accountId, row.thread_id)
            })()
            invalidateRevertedUndo(accountId, [queueIntentRef(intent, row.id)])
            this.notify()
            continue
          }
          const errorKind = classifyActionError(error)
          if (errorKind === 'permanent') {
            this.markRecovering(row, accountId, error)
            this.notify()
            const outcome = await this.recover(row, accountId, provider, intent, reverted)
            if (outcome.kind === 'continue') continue
            if (outcome.kind === 'retry') retryMs = outcome.delayMs
            break
          }
          this.markPending(row, accountId, error)
          this.notify()
          if (errorKind === 'auth') break
          retryMs = retryDelayMs(row.attempts)
          break
        }
      }
    } finally {
      if (reverted.length > 0) this.notifyReverted(accountId, reverted)
      if (!this.stopping && retryMs !== null && this.accountId() === accountId) {
        this.timerAccountId = accountId
        this.timer = this.time.timers.setTimeout(() => {
          this.timer = null
          this.timerAccountId = null
          void this.trigger()
        }, retryMs)
      }
    }
  }

  private async recover(
    row: QueueRow,
    accountId: string,
    provider: ActionRecoveryProvider,
    intent: QueueIntent,
    reverted: RevertedAction[]
  ): Promise<RecoveryOutcome> {
    if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
    try {
      const snapshot = await provider.getThread(row.thread_id, { format: 'full' })
      if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
      const messages = nonDraftMessages(snapshot.messages ?? [])
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
        if (messages.length === 0) deleteThread(this.db, accountId, row.thread_id)
        else persistThread(this.db, accountId, snapshot)
      })()
      invalidateRevertedUndo(accountId, [queueIntentRef(intent, row.id)])
      const returnedToInbox = messages.some((message) => message.labelIds?.includes('INBOX'))
      reverted.push(revertedAction(intent, row.subject ?? '', returnedToInbox))
      this.notify()
      return { kind: 'continue' }
    } catch (error) {
      if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
      if (error instanceof GmailApiError && error.status === 404) {
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
          deleteThread(this.db, accountId, row.thread_id)
        })()
        invalidateRevertedUndo(accountId, [queueIntentRef(intent, row.id)])
        reverted.push(revertedAction(intent, row.subject ?? '', false))
        this.notify()
        return { kind: 'continue' }
      }
      this.markRecovering(row, accountId, error, true)
      this.notify()
      return classifyActionError(error) === 'auth'
        ? { kind: 'pause' }
        : { kind: 'retry', delayMs: retryDelayMs(row.attempts) }
    }
  }

  private markPending(row: QueueRow, accountId: string, error: unknown): void {
    this.db
      .prepare(
        `UPDATE action_queue SET state = 'pending', attempts = attempts + 1, last_error = ?
         WHERE account_id = ? AND id = ?`
      )
      .run(error instanceof Error ? error.message : String(error), accountId, row.id)
  }

  private markRecovering(row: QueueRow, accountId: string, error: unknown, incrementAttempts = false): void {
    this.db
      .prepare(
        `UPDATE action_queue
         SET state = 'recovering', attempts = attempts + ?, last_error = ?
         WHERE account_id = ? AND id = ?`
      )
      .run(
        incrementAttempts ? 1 : 0,
        error instanceof Error ? error.message : String(error),
        accountId,
        row.id
      )
  }

  private prepareLegacyFailures(accountId: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, state, last_error FROM action_queue
         WHERE account_id = ? AND state = 'failed'`
      )
      .all(accountId) as FailedAuthRow[]
    const preparePermanent = this.db.prepare(
      "UPDATE action_queue SET state = 'recovering' WHERE account_id = ? AND id = ?"
    )
    const prepareAuth = this.db.prepare(
      "UPDATE action_queue SET state = 'pending' WHERE account_id = ? AND id = ?"
    )
    let prepared = 0
    this.db.transaction(() => {
      for (const row of rows) {
        const statement = isStoredAuthActionError(row.last_error) ? prepareAuth : preparePermanent
        prepared += statement.run(accountId, row.id).changes
      }
    })()
    return prepared
  }
}
