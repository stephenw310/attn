export type SyncRetryRoute = 'none' | 'seed' | 'poller' | 'queue-backfill' | 'start-backfill'

export function syncRetryRoute({
  signedIn,
  seeded,
  hasPoller,
  backfillRunning
}: {
  signedIn: boolean
  seeded: boolean
  hasPoller: boolean
  backfillRunning: boolean
}): SyncRetryRoute {
  if (!signedIn) return 'none'
  if (seeded) return 'seed'
  if (hasPoller) return 'poller'
  return backfillRunning ? 'queue-backfill' : 'start-backfill'
}

export class OfflineRetryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly delayMs: number) {}

  schedule(canRetry: () => boolean, retry: () => void): boolean {
    if (this.timer || !canRetry()) return false
    this.timer = setTimeout(() => {
      this.timer = null
      if (canRetry()) retry()
    }, this.delayMs)
    return true
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
