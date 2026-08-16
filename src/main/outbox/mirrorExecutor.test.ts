import { afterEach, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { systemTime } from '../time'
import type { drainDraftMirrors } from './mirror'
import { DraftMirrorExecutor } from './mirrorExecutor'

afterEach(() => vi.useRealTimers())

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
    systemTime,
    drain
  )

  const running = executor.trigger()
  let stopped = false
  const stopping = executor.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)

  release()
  await Promise.all([running, stopping])
  expect(stopped).toBe(true)
  await executor.trigger()
  expect(drain).toHaveBeenCalledOnce()
})

it('aborts a stalled Gmail checkpoint after the shutdown grace period', async () => {
  vi.useFakeTimers()
  let observedSignal: AbortSignal | undefined
  const drain = vi.fn<typeof drainDraftMirrors>(
    async (_db, _accountId, _provider, _shouldContinue, _spoolRoot, signal) =>
      new Promise<void>((_resolve, reject) => {
        observedSignal = signal
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const executor = new DraftMirrorExecutor(
    {} as Db,
    () => 'user@example.com',
    () => null,
    systemTime,
    drain
  )

  const running = executor.trigger()
  await vi.waitFor(() => expect(observedSignal).toBeDefined())
  const stopping = executor.stop()
  await vi.advanceTimersByTimeAsync(5_000)
  await Promise.all([running, stopping])

  expect(observedSignal?.aborted).toBe(true)
})
