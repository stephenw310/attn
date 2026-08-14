import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { drainDraftMirrors } from './mirror'

export class DraftMirrorExecutor {
  private drainPromise: Promise<void> | null = null
  private stopping = false
  private timer: TimerHandle | null = null
  private attempts = 0

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailActionProvider | null,
    private readonly time: SchedulerTime = systemTime
  ) {}

  trigger(): Promise<void> {
    if (this.stopping || this.timer) return Promise.resolve()
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
    if (!accountId) return
    try {
      await drainDraftMirrors(this.db, accountId, this.provider())
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
