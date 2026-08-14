import { describe, expect, it, vi } from 'vitest'
import type { Db } from './db'
import { SnoozeScheduler } from './scheduler'
import type { SchedulerTime, TimerHandle } from './time'

function schedulingDb(dueAt: number): Db {
  return {
    prepare: (sql: string) => ({
      all: () => [],
      get: () => (sql.includes('SELECT due_at') ? { due_at: dueAt } : undefined)
    })
  } as unknown as Db
}

describe('snooze scheduler time seam', () => {
  it('arms and cancels through injected time without waiting on the wall clock', () => {
    const handle = {} as TimerHandle
    const setTimeout = vi.fn(() => handle)
    const clearTimeout = vi.fn()
    const time: SchedulerTime = {
      now: () => 10_000,
      timers: { setTimeout, clearTimeout }
    }
    const scheduler = new SnoozeScheduler(
      schedulingDb(12_500),
      () => 'seed@attn.test',
      () => {},
      () => {},
      time
    )

    scheduler.start()
    expect(setTimeout).toHaveBeenCalledOnce()
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 2_500)

    scheduler.stop()
    expect(clearTimeout).toHaveBeenCalledWith(handle)
  })
})
