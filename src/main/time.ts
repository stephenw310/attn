export type TimerHandle = ReturnType<typeof setTimeout>

export interface TimerFactory {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** Time dependencies for durable schedulers, injectable in unit tests. */
export interface SchedulerTime {
  now(): number
  timers: TimerFactory
}

export const systemTime: SchedulerTime = {
  now: () => Date.now(),
  timers: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle)
  }
}
