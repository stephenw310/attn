import { describe, expect, it } from 'vitest'
import type { Db } from './db'
import { SnoozeScheduler } from './scheduler'
import type { SchedulerTime, TimerHandle } from './time'

interface ArmedTimer {
  callback: () => void
  delayMs: number
}

interface Harness {
  scheduler: SnoozeScheduler
  handle: TimerHandle
  armed: ArmedTimer[]
  cleared: TimerHandle[]
  dueQueries: number[]
  advanceTo: (at: number) => void
}

/**
 * Stands in for the reminders table with nothing ever due, so `returnThreads`
 * short-circuits before it needs `transaction`/`run`. Teaching this fake to
 * return due rows means giving it those too.
 */
function harness(dueAt: number): Harness {
  const handle = {} as TimerHandle
  const armed: ArmedTimer[] = []
  const cleared: TimerHandle[] = []
  const dueQueries: number[] = []
  let now = 10_000

  const db = {
    prepare: (sql: string) => ({
      all: (_accountId: string, at: number) => {
        dueQueries.push(at)
        return []
      },
      get: () => (sql.includes('SELECT due_at') ? { due_at: dueAt } : undefined)
    })
  } as unknown as Db

  const time: SchedulerTime = {
    now: () => now,
    timers: {
      setTimeout: (callback, delayMs) => {
        armed.push({ callback, delayMs })
        return handle
      },
      clearTimeout: (timer) => {
        cleared.push(timer)
      }
    }
  }

  const scheduler = new SnoozeScheduler(
    db,
    () => 'seed@attn.test',
    () => {},
    () => {},
    time
  )

  return {
    scheduler,
    handle,
    armed,
    cleared,
    dueQueries,
    advanceTo: (at) => {
      now = at
    }
  }
}

describe('snooze scheduler time seam', () => {
  it('arms and cancels through injected time without waiting on the wall clock', () => {
    const { scheduler, handle, armed, cleared } = harness(12_500)

    scheduler.start()
    expect(armed).toHaveLength(1)
    expect(armed[0].delayMs).toBe(2_500)

    scheduler.stop()
    expect(cleared).toEqual([handle])
  })

  it('re-checks due reminders when the armed timer fires', () => {
    const { scheduler, handle, armed, cleared, dueQueries, advanceTo } = harness(12_500)

    scheduler.start()
    expect(dueQueries).toEqual([10_000])

    // Firing the armed callback is the whole point of the seam: the undo-send
    // and outbox windows elapse here rather than in real time.
    advanceTo(12_500)
    armed[0].callback()

    expect(dueQueries).toEqual([10_000, 12_500])
    expect(cleared).toEqual([handle])
    expect(armed[1].delayMs).toBe(0)
  })
})
