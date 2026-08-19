import { expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import type { drainDraftMirrors } from './mirror'
import { DraftMirrorExecutor } from './mirrorExecutor'

class ManualTime implements SchedulerTime {
  private current = 0
  private nextId = 1
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>()

  readonly timers = {
    setTimeout: (callback: () => void, delayMs: number): TimerHandle => {
      const id = this.nextId++
      this.scheduled.set(id, { at: this.current + delayMs, callback })
      return id as unknown as TimerHandle
    },
    clearTimeout: (handle: TimerHandle): void => {
      this.scheduled.delete(handle as unknown as number)
    }
  }

  now(): number {
    return this.current
  }

  nextDelay(): number | null {
    const next = [...this.scheduled.values()].sort((left, right) => left.at - right.at)[0]
    return next ? next.at - this.current : null
  }

  advance(ms: number): void {
    this.current += ms
    const due = [...this.scheduled.entries()].filter(([, timer]) => timer.at <= this.current)
    for (const [id, timer] of due) {
      this.scheduled.delete(id)
      timer.callback()
    }
  }
}

it('quiesces the active checkpoint before shutdown and declines another row', async () => {
  let release: () => void = () => {}
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve
  })
  const drain = vi.fn<typeof drainDraftMirrors>(async (_db, _accountId, _provider, shouldContinue) => {
    expect(shouldContinue?.()).toBe(true)
    await checkpoint
    expect(shouldContinue?.()).toBe(false)
  })
  const executor = new DraftMirrorExecutor(
    {} as Db,
    () => 'user@example.com',
    () => null,
    { time: systemTime, drainDrafts: drain }
  )

  const running = executor.trigger()
  expect(executor.isRunning()).toBe(true)
  let stopped = false
  const stopping = executor.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)

  release()
  await Promise.all([running, stopping])
  expect(stopped).toBe(true)
  expect(executor.isRunning()).toBe(false)
  await executor.trigger()
  expect(drain).toHaveBeenCalledOnce()
})

it('aborts a stalled checkpoint after the shutdown grace period', async () => {
  const time = new ManualTime()
  let observedSignal: AbortSignal | undefined
  const drain = vi.fn<typeof drainDraftMirrors>(
    async (_db, _accountId, _provider, _shouldContinue, _spoolRoot, signal) => {
      observedSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
  )
  const executor = new DraftMirrorExecutor(
    {} as Db,
    () => 'user@example.com',
    () => null,
    { time, drainDrafts: drain }
  )

  const running = executor.trigger()
  await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
  const stopping = executor.stop()
  expect(time.nextDelay()).toBe(5_000)

  time.advance(5_000)
  await Promise.all([running, stopping])

  expect(observedSignal?.aborted).toBe(true)
  await executor.trigger()
  expect(drain).toHaveBeenCalledOnce()
})
