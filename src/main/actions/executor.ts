import type { RevertedAction, RevertedActionKind } from '../../shared/actionRevert'
import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { nonDraftMessages, persistThread } from '../sync/persist'
import type { GetThreadOptions, MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { invalidateRevertedUndo } from '.'
import {
  classifyActionError,
  executeIntent,
  isStoredAuthActionError,
  isTypedStoredActionError,
  type QueueIntent,
  retryDelayMs,
  storeActionError
} from './execute'
import { decodeLabelDelta } from './queuePayload'
import { queueRowRef, revertedAction, unavailableAction } from './revert'

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
  account_id: string
  state: 'pending' | 'recovering' | 'failed'
  last_error: string | null
}

interface DecodedQueueRow {
  intent: QueueIntent
  actionKind?: RevertedActionKind
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
    this.prepareLegacyFailures()
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
        `SELECT id, account_id, state, last_error FROM action_queue
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
          const outcome = await this.recover(row, accountId, provider, null, 'labels', reverted)
          if (outcome.kind === 'continue') continue
          if (outcome.kind === 'retry') retryMs = outcome.delayMs
          break
        }
        const { intent, actionKind } = decoded
        if (row.state === 'recovering') {
          const outcome = await this.recover(row, accountId, provider, intent, actionKind, reverted)
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
          const errorKind = classifyActionError(error)
          if (errorKind === 'permanent') {
            this.markRecovering(row, accountId, error, errorKind)
            this.notify()
            const outcome = await this.recover(row, accountId, provider, intent, actionKind, reverted)
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
    intent: QueueIntent | null,
    actionKind: RevertedActionKind | undefined,
    reverted: RevertedAction[]
  ): Promise<RecoveryOutcome> {
    if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
    try {
      const snapshot = await provider.getThread(row.thread_id, { format: 'full' })
      if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
      const messages = nonDraftMessages(snapshot.messages ?? [])
      if (messages.length === 0) {
        this.finishUnrecoverable(row, accountId, actionKind, reverted)
        return { kind: 'continue' }
      }
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
        persistThread(this.db, accountId, snapshot)
      })()
      invalidateRevertedUndo(accountId, [queueRowRef(row.id, row.thread_id)])
      const returnedToInbox = messages.some((message) => message.labelIds?.includes('INBOX'))
      reverted.push(
        revertedAction(
          intent ?? this.fallbackIntent(row),
          row.subject ?? '',
          returnedToInbox,
          'restored',
          actionKind
        )
      )
      this.notify()
      return { kind: 'continue' }
    } catch (error) {
      if (this.stopping || this.accountId() !== accountId) return { kind: 'stop' }
      const errorKind = classifyActionError(error)
      if (errorKind === 'permanent') {
        this.finishUnrecoverable(row, accountId, actionKind, reverted)
        return { kind: 'continue' }
      }
      this.markRecovering(row, accountId, error, errorKind, true)
      this.notify()
      return errorKind === 'auth' ? { kind: 'pause' } : { kind: 'retry', delayMs: retryDelayMs(row.attempts) }
    }
  }

  private decodeRow(row: QueueRow): DecodedQueueRow {
    if (row.kind !== 'modifyLabels') {
      return { intent: { kind: row.kind, threadId: row.thread_id } }
    }
    const payload = decodeLabelDelta(row.payload)
    return {
      intent: {
        kind: row.kind,
        threadId: row.thread_id,
        add: payload.add,
        remove: payload.remove
      },
      actionKind: payload.actionKind
    }
  }

  private fallbackIntent(row: QueueRow): QueueIntent {
    return row.kind === 'modifyLabels'
      ? { kind: row.kind, threadId: row.thread_id, add: [], remove: [] }
      : { kind: row.kind, threadId: row.thread_id }
  }

  private finishUnrecoverable(
    row: QueueRow,
    accountId: string,
    actionKind: RevertedActionKind | undefined,
    reverted: RevertedAction[]
  ): void {
    this.db.prepare('DELETE FROM action_queue WHERE account_id = ? AND id = ?').run(accountId, row.id)
    invalidateRevertedUndo(accountId, [queueRowRef(row.id, row.thread_id)])
    reverted.push(unavailableAction(row.kind, row.thread_id, row.subject ?? '', actionKind))
    this.notify()
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

  private prepareLegacyFailures(): void {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, state, last_error FROM action_queue
         WHERE state IN ('pending', 'recovering', 'failed')`
      )
      .all() as FailedAuthRow[]
    const prepare = this.db.prepare(
      'UPDATE action_queue SET state = ?, last_error = ? WHERE account_id = ? AND id = ?'
    )
    this.db.transaction(() => {
      for (const row of rows) {
        const auth = isStoredAuthActionError(row.last_error)
        if (row.state !== 'failed' && !auth) continue
        const state = row.state === 'failed' ? (auth ? 'pending' : 'recovering') : row.state
        const lastError =
          auth && !isTypedStoredActionError(row.last_error)
            ? storeActionError(row.last_error ?? 'legacy authentication failure', 'auth')
            : row.last_error
        prepare.run(state, lastError, row.account_id, row.id)
      }
    })()
  }
}
