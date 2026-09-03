import { describe, expect, it, vi } from 'vitest'
import { GracefulDrainer } from './drain'
import type { SchedulerTime, TimerHandle } from './time'

class ManualTime implements SchedulerTime {
  private nextId = 1
  private current = 0
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>()

  now = (): number => this.current

  timers = {
    setTimeout: (callback: () => void, delayMs: number): TimerHandle => {
      const id = this.nextId++
      this.scheduled.set(id, { at: this.current + delayMs, callback })
      return id as unknown as TimerHandle
    },
    clearTimeout: (handle: TimerHandle): void => {
      this.scheduled.delete(handle as unknown as number)
    }
  }

  get armed(): number {
    return this.scheduled.size
  }

  advance(ms: number): void {
    this.current += ms
    for (const [id, timer] of [...this.scheduled.entries()]) {
      if (timer.at > this.current) continue
      this.scheduled.delete(id)
      timer.callback()
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('GracefulDrainer', () => {
  it('runs one drain at a time and hands every concurrent trigger the same promise', async () => {
    const gate = deferred()
    const run = vi.fn(() => gate.promise)
    const drainer = new GracefulDrainer(run, { time: new ManualTime() })

    const first = drainer.trigger()
    const second = drainer.trigger()
    expect(first).toBe(second)
    expect(drainer.isRunning()).toBe(true)
    gate.resolve()
    await first
    expect(drainer.isRunning()).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fires an armed timer once and forgets it', async () => {
    const time = new ManualTime()
    const run = vi.fn(async () => {})
    const drainer = new GracefulDrainer(run, { time })

    drainer.arm(500)
    expect(drainer.hasTimer()).toBe(true)
    time.advance(500)
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    expect(drainer.hasTimer()).toBe(false)
  })

  it('lets the default policy preempt an armed retry timer', async () => {
    const time = new ManualTime()
    const run = vi.fn(async () => {})
    const drainer = new GracefulDrainer(run, { time })

    drainer.arm(60_000)
    await drainer.trigger()
    expect(run).toHaveBeenCalledTimes(1)
    expect(time.armed).toBe(0)
  })

  it('keeps a backoff ladder when the policy declines to preempt', async () => {
    const time = new ManualTime()
    const run = vi.fn(async () => {})
    const drainer = new GracefulDrainer(run, { time, preemptTimer: () => false })

    drainer.arm(60_000)
    await drainer.trigger()
    expect(run).not.toHaveBeenCalled()
    expect(drainer.hasTimer()).toBe(true)
  })

  it('offers the armed tag to the policy so a caller can preempt selectively', async () => {
    const time = new ManualTime()
    const run = vi.fn(async () => {})
    const drainer = new GracefulDrainer(run, { time, preemptTimer: (tag) => tag === 'other' })

    drainer.arm(60_000, 'mine')
    await drainer.trigger()
    expect(run).not.toHaveBeenCalled()

    drainer.arm(60_000, 'other')
    await drainer.trigger()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('declines further work after halt and accepts it again after start', async () => {
    const drainer = new GracefulDrainer(async () => {}, { time: new ManualTime() })
    drainer.halt()
    await drainer.trigger()
    expect(drainer.isRunning()).toBe(false)
    drainer.start()
    await drainer.trigger()
    expect(drainer.isStopping()).toBe(false)
  })

  it('lets an active drain settle inside the grace period without aborting it', async () => {
    const time = new ManualTime()
    const gate = deferred()
    const abort = vi.fn()
    const drainer = new GracefulDrainer(() => gate.promise, { time, graceMs: 5_000, abort })

    void drainer.trigger()
    const stopped = drainer.stop()
    gate.resolve()
    await stopped
    expect(abort).not.toHaveBeenCalled()
  })

  it('aborts a stalled drain once the grace period elapses and waits for it', async () => {
    const time = new ManualTime()
    const gate = deferred()
    const abort = vi.fn(() => gate.resolve())
    const drainer = new GracefulDrainer(() => gate.promise, { time, graceMs: 5_000, abort })

    void drainer.trigger()
    const stopped = drainer.stop()
    await Promise.resolve()
    expect(abort).not.toHaveBeenCalled()
    time.advance(5_000)
    await stopped
    expect(abort).toHaveBeenCalledTimes(1)
    expect(drainer.isRunning()).toBe(false)
  })
})
