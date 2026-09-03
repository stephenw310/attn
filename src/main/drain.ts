import { type SchedulerTime, systemTime, type TimerHandle } from './time'

export interface GracefulDrainerOptions {
  time?: SchedulerTime
  /**
   * How long a `stop()` lets the in-flight drain finish on its own before the
   * abort fires. Required by every caller that owns a network abort.
   */
  graceMs?: number
  /** Abort the drain's in-flight remote request once the grace period elapses. */
  abort?: () => void
  /**
   * Decides what a `trigger()` does while a retry timer is armed. `true`
   * cancels the timer and drains now; `false` leaves the ladder alone and the
   * trigger resolves immediately. The armed tag is whatever `arm()` recorded.
   */
  preemptTimer?: (tag: string | null) => boolean
}

/**
 * The trigger/timer/stop plumbing every main-process drain loop needs: one
 * in-flight drain at a time, one retry timer, and a shutdown that gives the
 * active drain a bounded chance to finish before its remote request is
 * aborted. The loop body itself stays with its owner — only the scheduling
 * around it is shared (review R4).
 */
export class GracefulDrainer {
  private drainPromise: Promise<void> | null = null
  private timer: TimerHandle | null = null
  private timerTag: string | null = null
  private stopping = false

  private readonly time: SchedulerTime
  private readonly graceMs: number
  private readonly abort: () => void
  private readonly preemptTimer: (tag: string | null) => boolean

  constructor(
    private readonly run: () => Promise<void>,
    options: GracefulDrainerOptions = {}
  ) {
    this.time = options.time ?? systemTime
    this.graceMs = options.graceMs ?? 0
    this.abort = options.abort ?? (() => {})
    this.preemptTimer = options.preemptTimer ?? (() => true)
  }

  /** True only while the drain body is running, not while a retry timer is idle. */
  isRunning(): boolean {
    return this.drainPromise !== null
  }

  /** The drain currently in flight, or `null`. */
  active(): Promise<void> | null {
    return this.drainPromise
  }

  isStopping(): boolean {
    return this.stopping
  }

  hasTimer(): boolean {
    return this.timer !== null
  }

  /** Accept work again after a `stop()`/`halt()`. */
  start(): void {
    this.stopping = false
  }

  trigger(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.timer) {
      if (!this.preemptTimer(this.timerTag)) return Promise.resolve()
      this.clearTimer()
    }
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.run().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
  }

  /** Schedule one deferred `trigger()`, replacing any timer already armed. */
  arm(delayMs: number, tag: string | null = null): void {
    this.clearTimer()
    this.timerTag = tag
    this.timer = this.time.timers.setTimeout(() => {
      this.timer = null
      this.timerTag = null
      void this.trigger()
    }, delayMs)
  }

  clearTimer(): void {
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    this.timerTag = null
  }

  /** Decline further work immediately, without waiting for the active drain. */
  halt(): void {
    this.stopping = true
    this.clearTimer()
  }

  /**
   * Decline further work, then give the active drain `graceMs` to settle before
   * aborting its remote request. The returned promise resolves only once the
   * drain has actually finished, so a caller may close its database behind it.
   */
  async stop(): Promise<void> {
    this.halt()
    const drain = this.drainPromise
    if (!drain) return
    let timeout: TimerHandle | null = null
    const timedOut = await Promise.race([
      drain.then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = this.time.timers.setTimeout(() => resolve(true), this.graceMs)
      })
    ])
    if (timeout) this.time.timers.clearTimeout(timeout)
    if (!timedOut) return
    this.abort()
    await drain
  }
}
