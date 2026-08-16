import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { drainDraftMirrors } from './mirror'

type MirrorDrain = typeof drainDraftMirrors
const STOP_TIMEOUT_MS = 5_000

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

export class DraftMirrorExecutor {
  private drainPromise: Promise<void> | null = null
  private remoteAbortController: AbortController | null = null
  private stopping = false
  private timer: TimerHandle | null = null
  private attempts = 0

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailActionProvider | null,
    private readonly time: SchedulerTime = systemTime,
    private readonly drainDrafts: MirrorDrain = drainDraftMirrors,
    private readonly spoolRoot: string | null = null
  ) {}

  trigger(): Promise<void> {
    if (this.stopping || this.timer) return Promise.resolve()
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
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
        timeout = this.time.timers.setTimeout(() => resolve(true), STOP_TIMEOUT_MS)
      })
    ])
    if (timeout) this.time.timers.clearTimeout(timeout)
    if (!timedOut) return
    this.remoteAbortController?.abort(new Error('draft checkpoint shutdown'))
    await drain
  }

  /** Let a queued send wait for any checkpoint that already selected its row. */
  waitForIdle(signal?: AbortSignal): Promise<void> {
    return waitForAbortable(this.drainPromise ?? Promise.resolve(), signal)
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    if (!accountId) return
    const controller = new AbortController()
    this.remoteAbortController = controller
    try {
      // Finish the current remote checkpoint so its returned Gmail id reaches
      // SQLite, then decline the next row once shutdown has started.
      await this.drainDrafts(
        this.db,
        accountId,
        this.provider(),
        () => !this.stopping,
        this.spoolRoot,
        controller.signal
      )
      this.attempts = 0
    } catch (error) {
      if (this.stopping) return
      console.error(`[draft] mirror failed: ${error instanceof Error ? error.message : String(error)}`)
      const retryable = !(error instanceof GmailApiError) || error.retryable
      if (!retryable) return
      const delay = retryDelayMs(this.attempts++)
      this.timer = this.time.timers.setTimeout(() => {
        this.timer = null
        void this.trigger()
      }, delay)
    } finally {
      if (this.remoteAbortController === controller) this.remoteAbortController = null
    }
  }
}
