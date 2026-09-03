import { errorMessage } from '../../shared/error'
import { MIRROR_STOP_TIMEOUT_MS } from '../../shared/outboxTuning'
import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { DraftMirrorRowError, drainDraftMirrors } from './mirror'

type MirrorDrain = typeof drainDraftMirrors

function waitForAbortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('request aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      () => {
        signal.removeEventListener('abort', abort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

export interface DraftMirrorExecutorOptions {
  time?: SchedulerTime
  drainDrafts?: MirrorDrain
  spoolRoot?: string | null
}

export class DraftMirrorExecutor {
  private drainPromise: Promise<void> | null = null
  private remoteAbortController: AbortController | null = null
  private stopping = false
  private timer: TimerHandle | null = null
  private attempts = 0
  /** Rows Gmail permanently rejected, against the local revision it rejected. */
  private readonly rejectedRows = new Map<string, number | null>()

  private readonly time: SchedulerTime
  private readonly drainDrafts: MirrorDrain
  private readonly spoolRoot: string | null

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailActionProvider | null,
    options: DraftMirrorExecutorOptions = {}
  ) {
    this.time = options.time ?? systemTime
    this.drainDrafts = options.drainDrafts ?? drainDraftMirrors
    this.spoolRoot = options.spoolRoot ?? null
  }

  trigger(): Promise<void> {
    if (this.stopping || this.timer) return Promise.resolve()
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
  }

  /** True only while a draft checkpoint is active, not while its retry timer is idle. */
  isRunning(): boolean {
    return this.drainPromise !== null
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    const drain = this.drainPromise
    if (!drain) return
    let timeout: TimerHandle | null = null
    const timedOut = await Promise.race([
      drain.then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = this.time.timers.setTimeout(() => resolve(true), MIRROR_STOP_TIMEOUT_MS)
      })
    ])
    if (timeout) this.time.timers.clearTimeout(timeout)
    if (!timedOut) return
    this.remoteAbortController?.abort(new Error('draft mirror shutdown'))
    await drain
  }

  /** Let a queued send wait for any checkpoint that already selected its row. */
  waitForIdle(signal?: AbortSignal): Promise<void> {
    return waitForAbortable(this.drainPromise ?? Promise.resolve(), signal)
  }

  /**
   * A row Gmail rejected outright — a malformed address, say — is rejected the
   * same way every time, so it waits for the user to change it instead of
   * spending a request a minute for the life of the draft. Any later revision
   * (or a row that has since gone) clears the block.
   */
  private isRejected(accountId: string, rowId: string): boolean {
    const rejectedRevision = this.rejectedRows.get(rowId)
    if (rejectedRevision === undefined) return false
    if (rejectedRevision === this.localRevisionOf(accountId, rowId)) return true
    this.rejectedRows.delete(rowId)
    return false
  }

  private localRevisionOf(accountId: string, rowId: string): number | null {
    const row = this.db
      .prepare('SELECT local_revision FROM outbox WHERE account_id = ? AND id = ?')
      .get(accountId, rowId) as { local_revision: number } | undefined
    return row?.local_revision ?? null
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    if (!accountId) return
    const provider = this.provider()
    const controller = new AbortController()
    this.remoteAbortController = controller
    try {
      for (;;) {
        try {
          // Give the current checkpoint a bounded chance to persist its returned
          // Gmail id, then decline the next row once shutdown has started.
          await this.drainDrafts(
            this.db,
            accountId,
            provider,
            () => !this.stopping,
            this.spoolRoot,
            controller.signal,
            (rowId) => this.isRejected(accountId, rowId)
          )
          this.attempts = 0
          return
        } catch (error) {
          if (this.stopping) return
          const rowError = error instanceof DraftMirrorRowError ? error : null
          const reason = rowError?.reason ?? error
          console.error(`[draft] mirror failed: ${errorMessage(reason)}`)
          const retryable = !(reason instanceof GmailApiError) || reason.retryable
          if (!retryable && rowError) {
            this.rejectedRows.set(rowError.rowId, this.localRevisionOf(accountId, rowError.rowId))
            continue
          }
          if (!retryable) return
          const delay = retryDelayMs(this.attempts++)
          this.timer = this.time.timers.setTimeout(() => {
            this.timer = null
            void this.trigger()
          }, delay)
          return
        }
      }
    } finally {
      if (this.remoteAbortController === controller) this.remoteAbortController = null
    }
  }
}
