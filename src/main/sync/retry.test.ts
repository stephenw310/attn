import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineRetryScheduler, syncRetryRoute } from './retry'

afterEach(() => {
  vi.useRealTimers()
})

describe('sync retry routing', () => {
  it('selects the real poller and backfill paths', () => {
    expect(syncRetryRoute({ signedIn: true, seeded: false, hasPoller: true, backfillRunning: false })).toBe(
      'poller'
    )
    expect(syncRetryRoute({ signedIn: true, seeded: false, hasPoller: false, backfillRunning: true })).toBe(
      'queue-backfill'
    )
    // An alive poller no longer implies the backfill finished (interactive-ready start).
    expect(syncRetryRoute({ signedIn: true, seeded: false, hasPoller: true, backfillRunning: true })).toBe(
      'queue-backfill'
    )
    expect(syncRetryRoute({ signedIn: true, seeded: false, hasPoller: false, backfillRunning: false })).toBe(
      'start-backfill'
    )
  })

  it('keeps signed-out and deterministic seed behavior explicit', () => {
    expect(syncRetryRoute({ signedIn: false, seeded: false, hasPoller: true, backfillRunning: false })).toBe(
      'none'
    )
    expect(syncRetryRoute({ signedIn: true, seeded: true, hasPoller: false, backfillRunning: false })).toBe(
      'seed'
    )
  })
})

describe('offline retry scheduler', () => {
  it('coalesces retries and rechecks the session before running', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    let currentSession = true
    const scheduler = new OfflineRetryScheduler(15_000)

    expect(scheduler.schedule(() => currentSession, retry)).toBe(true)
    expect(scheduler.schedule(() => currentSession, retry)).toBe(false)
    currentSession = false
    await vi.advanceTimersByTimeAsync(15_000)
    expect(retry).not.toHaveBeenCalled()

    currentSession = true
    expect(scheduler.schedule(() => currentSession, retry)).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('cancels a pending retry', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const scheduler = new OfflineRetryScheduler(15_000)
    scheduler.schedule(() => true, retry)
    scheduler.clear()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(retry).not.toHaveBeenCalled()
  })
})
