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
  private blockedTimer: TimerHandle | null = null
  private attempts = 0
  private readonly rowBackoff = new Map<string, { attempts: number; nextAttemptAt: number }>()

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
    if (this.blockedTimer) this.time.timers.clearTimeout(this.blockedTimer)
    this.blockedTimer = null
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
    if (this.blockedTimer) this.time.timers.clearTimeout(this.blockedTimer)
    this.timer = null
    this.blockedTimer = null
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

  private scheduleBlockedRetry(): void {
    if (this.stopping) return
    if (this.blockedTimer) this.time.timers.clearTimeout(this.blockedTimer)
    this.blockedTimer = null
    const now = this.time.now()
    const nextAttemptAt = Math.min(
      ...[...this.rowBackoff.values()]
        .map((entry) => entry.nextAttemptAt)
        .filter((attemptAt) => attemptAt > now)
    )
    if (!Number.isFinite(nextAttemptAt)) return
    this.blockedTimer = this.time.timers.setTimeout(() => {
      this.blockedTimer = null
      void this.trigger()
    }, nextAttemptAt - now)
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
            (rowId) => (this.rowBackoff.get(rowId)?.nextAttemptAt ?? 0) > this.time.now()
          )
          this.attempts = 0
          const now = this.time.now()
          for (const [rowId, backoff] of this.rowBackoff) {
            if (backoff.nextAttemptAt <= now) this.rowBackoff.delete(rowId)
          }
          this.scheduleBlockedRetry()
          return
        } catch (error) {
          if (this.stopping) return
          const rowError = error instanceof DraftMirrorRowError ? error : null
          const reason = rowError?.reason ?? error
          console.error(`[draft] mirror failed: ${errorMessage(reason)}`)
          const retryable = !(reason instanceof GmailApiError) || reason.retryable
          if (!retryable && rowError) {
            const previous = this.rowBackoff.get(rowError.rowId)
            const attempts = previous?.attempts ?? 0
            this.rowBackoff.set(rowError.rowId, {
              attempts: attempts + 1,
              nextAttemptAt: this.time.now() + retryDelayMs(attempts)
            })
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
