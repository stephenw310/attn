import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { hydrateMissingThreadBodies } from './bodies'
import { missingBodyMessageIds } from './bodyHydration'
import { persistThread } from './persist'
import type { MailProvider } from './provider'
import { BODY_HYDRATION_TIMEOUT_MS, MAX_RETAINED_BODY_HYDRATION_STATES } from './tuning'

export type BodyHydrationAttemptState = 'idle' | 'loading' | 'unavailable'

export type TrackProviderWork = <T>(accountId: string, work: () => Promise<T>) => Promise<T>

export interface HydrationEffects {
  persist: (db: Db, accountId: string, thread: GmailThread) => void
  hydrateMissing: (
    db: Db,
    provider: MailProvider,
    accountId: string,
    thread: GmailThread,
    shouldContinue: () => boolean
  ) => Promise<void>
  missingMessageIds: (db: Db, accountId: string, threadId: string) => Set<string>
}

const productionEffects: HydrationEffects = {
  persist: persistThread,
  hydrateMissing: hydrateMissingThreadBodies,
  missingMessageIds: missingBodyMessageIds
}

interface ActiveAttempt {
  writable: boolean
  cancel: () => void
}

class HydrationStoppedError extends Error {}

export interface OnDemandBodyHydratorOptions {
  time?: SchedulerTime
  effects?: HydrationEffects
  trackProviderWork?: TrackProviderWork
}

/** Account-scoped single-flight coordinator for on-demand full-body fetches. */
export class OnDemandBodyHydrator {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly attempts = new Map<string, ActiveAttempt>()
  private readonly states = new Map<string, Exclude<BodyHydrationAttemptState, 'idle'>>()
  private stopped = false

  private readonly time: SchedulerTime
  private readonly effects: HydrationEffects
  private readonly trackProviderWork: TrackProviderWork

  constructor(
    private readonly db: Db,
    private readonly currentAccountId: () => string | null,
    private readonly onChanged: () => void,
    private readonly onUnavailable: (accountId: string, threadId: string, error?: unknown) => void,
    options: OnDemandBodyHydratorOptions = {}
  ) {
    this.time = options.time ?? systemTime
    this.effects = options.effects ?? productionEffects
    this.trackProviderWork = options.trackProviderWork ?? (async (_accountId, work) => work())
  }

  state(accountId: string, threadId: string): BodyHydrationAttemptState {
    return this.states.get(this.key(accountId, threadId)) ?? 'idle'
  }

  request(accountId: string, threadId: string, provider: MailProvider): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const key = this.key(accountId, threadId)
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const attemptState: ActiveAttempt = { writable: true, cancel: () => {} }
    this.attempts.set(key, attemptState)
    this.setState(key, 'loading')
    const attempt = this.trackProviderWork(accountId, () =>
      this.run(key, attemptState, accountId, threadId, provider)
    ).finally(() => {
      if (this.inFlight.get(key) === attempt) this.inFlight.delete(key)
      if (this.attempts.get(key) === attemptState) this.attempts.delete(key)
    })
    this.inFlight.set(key, attempt)
    return attempt
  }

  stop(): void {
    this.stopped = true
    for (const attempt of this.attempts.values()) attempt.cancel()
    this.attempts.clear()
    this.states.clear()
  }

  private async run(
    key: string,
    attempt: ActiveAttempt,
    accountId: string,
    threadId: string,
    provider: MailProvider
  ): Promise<void> {
    const missingBefore = this.effects.missingMessageIds(this.db, accountId, threadId)
    let failure: unknown
    try {
      await this.withTimeout(
        attempt,
        this.fetchAndPersist(attempt, accountId, threadId, provider),
        BODY_HYDRATION_TIMEOUT_MS
      )
    } catch (error) {
      failure = error
    }
    if (this.stopped || this.currentAccountId() !== accountId) {
      // No conclusion for a switched-away account, so leave no state behind:
      // a retained 'loading' makes every later read of this thread report an
      // in-progress hydration that nothing will ever finish.
      this.states.delete(key)
      return
    }

    const missingAfter = this.effects.missingMessageIds(this.db, accountId, threadId)
    const bodyChanged = [...missingBefore].some((messageId) => !missingAfter.has(messageId))
    if (missingAfter.size === 0) this.states.delete(key)
    else this.setState(key, 'unavailable')
    if (bodyChanged) this.onChanged()
    if (missingAfter.size > 0) {
      this.onUnavailable(accountId, threadId, failure instanceof HydrationStoppedError ? undefined : failure)
    }
  }

  private async fetchAndPersist(
    attempt: ActiveAttempt,
    accountId: string,
    threadId: string,
    provider: MailProvider
  ): Promise<void> {
    if (!this.canWrite(attempt, accountId)) return
    const thread = await provider.getThread(threadId, { format: 'full' })
    if (!this.canWrite(attempt, accountId)) return
    this.effects.persist(this.db, accountId, thread)
    if (!this.canWrite(attempt, accountId)) return
    await this.effects.hydrateMissing(this.db, provider, accountId, thread, () =>
      this.canWrite(attempt, accountId)
    )
  }

  private withTimeout<T>(attempt: ActiveAttempt, work: Promise<T>, delayMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: TimerHandle | null = this.time.timers.setTimeout(() => {
        attempt.writable = false
        finish(() => reject(new Error(`body hydration timed out after ${delayMs} ms`)))
      }, delayMs)
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        if (timer) this.time.timers.clearTimeout(timer)
        timer = null
        settle()
      }
      attempt.cancel = () => {
        attempt.writable = false
        finish(() => reject(new HydrationStoppedError('body hydration stopped')))
      }
      work.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
    })
  }

  private canWrite(attempt: ActiveAttempt, accountId: string): boolean {
    return !this.stopped && attempt.writable && this.currentAccountId() === accountId
  }

  private setState(key: string, state: Exclude<BodyHydrationAttemptState, 'idle'>): void {
    this.states.delete(key)
    this.states.set(key, state)
    if (state !== 'unavailable') return

    let unavailableCount = [...this.states.values()].filter((value) => value === 'unavailable').length
    if (unavailableCount <= MAX_RETAINED_BODY_HYDRATION_STATES) return
    for (const [candidate, candidateState] of this.states) {
      if (candidateState !== 'unavailable') continue
      this.states.delete(candidate)
      unavailableCount--
      if (unavailableCount <= MAX_RETAINED_BODY_HYDRATION_STATES) return
    }
  }

  private key(accountId: string, threadId: string): string {
    return `${accountId}\0${threadId}`
  }
}
