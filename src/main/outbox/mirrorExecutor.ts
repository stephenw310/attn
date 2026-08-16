import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { drainDraftMirrors } from './mirror'

type MirrorDrain = typeof drainDraftMirrors

export class DraftMirrorExecutor {
  private drainPromise: Promise<void> | null = null
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

  /** True only while a draft checkpoint is active, not while its retry timer is idle. */
  isRunning(): boolean {
    return this.drainPromise !== null
  }

  stop(): Promise<void> {
    this.stopping = true
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    return this.drainPromise ?? Promise.resolve()
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    if (!accountId) return
    try {
      // Finish the current remote checkpoint so its returned Gmail id reaches
      // SQLite, then decline the next row once shutdown has started.
      await this.drainDrafts(this.db, accountId, this.provider(), () => !this.stopping, this.spoolRoot)
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
    }
  }
}
