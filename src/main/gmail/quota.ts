import { type SchedulerTime, systemTime, type TimerHandle } from '../time'

/**
 * Gmail quota units and limits are documented at:
 * https://developers.google.com/workspace/gmail/api/reference/quota
 *
 * Google changed both on 2026-05-01. Keep this table explicit so a future
 * change is a data update rather than a scheduling rewrite.
 */
export const GMAIL_QUOTA_UNITS = {
  'drafts.create': 10,
  'drafts.delete': 10,
  'drafts.get': 20,
  'drafts.list': 5,
  'drafts.send': 100,
  'drafts.update': 15,
  getProfile: 1,
  'history.list': 2,
  'labels.list': 1,
  'messages.attachments.get': 20,
  'messages.get': 20,
  'messages.list': 5,
  'threads.get': 40,
  'threads.list': 10,
  'threads.modify': 10,
  'threads.trash': 20,
  'threads.untrash': 10
} as const

export type GmailQuotaMethod = keyof typeof GMAIL_QUOTA_UNITS

export type GmailRequestPriority = 'send' | 'action' | 'polling' | 'foreground' | 'background'

const PRIORITIES: GmailRequestPriority[] = ['send', 'action', 'polling', 'foreground', 'background']

export const DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE = 6_000

export interface GmailQuotaConfig {
  /** The actual per-minute, per-user quota configured for this OAuth project. */
  unitsPerMinute: number
  /** Maximum burst. Defaults to one minute or the largest Gmail call, whichever is larger. */
  capacity?: number
  /**
   * Tokens that lower-priority work cannot spend. These are cumulative floors:
   * background keeps every foreground reserve intact, while sends can consume
   * the entire bucket if delivery itself needs the capacity.
   */
  reservedUnits?: Partial<Record<GmailRequestPriority, number>>
}

export interface GmailQuotaMetrics {
  requests: number
  units: number
  waitMs: number
}

export interface GmailQuotaLimiterOptions {
  time?: SchedulerTime
}

interface Waiter {
  id: number
  cost: number
  priority: GmailRequestPriority
  enqueuedAt: number
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

const DEFAULT_RESERVED_UNITS: Record<GmailRequestPriority, number> = {
  send: 0,
  action: 200,
  polling: 300,
  foreground: 400,
  background: 500
}
const MAX_REQUEST_COST = Math.max(...Object.values(GMAIL_QUOTA_UNITS))

/** A priority queue over one continuously-refilled, weighted token bucket. */
export class GmailQuotaLimiter {
  private readonly time: SchedulerTime
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly reservedUnits: Record<GmailRequestPriority, number>
  private tokens: number
  private refilledAt: number
  private nextWaiterId = 1
  private waiters: Waiter[] = []
  private timer: TimerHandle | null = null
  private metrics: GmailQuotaMetrics = { requests: 0, units: 0, waitMs: 0 }

  constructor(config: GmailQuotaConfig, options: GmailQuotaLimiterOptions = {}) {
    if (!Number.isFinite(config.unitsPerMinute) || config.unitsPerMinute <= 0) {
      throw new Error('Gmail quota units per minute must be positive')
    }
    this.time = options.time ?? systemTime
    this.capacity = config.capacity ?? Math.max(config.unitsPerMinute, MAX_REQUEST_COST)
    if (!Number.isFinite(this.capacity) || this.capacity <= 0) {
      throw new Error('Gmail quota capacity must be positive')
    }
    this.refillPerMs = config.unitsPerMinute / 60_000
    this.reservedUnits = { ...DEFAULT_RESERVED_UNITS, ...config.reservedUnits }
    for (const priority of PRIORITIES) {
      this.reservedUnits[priority] = Math.min(this.capacity, this.reservedUnits[priority])
    }
    this.tokens = this.capacity
    this.refilledAt = this.time.now()
  }

  acquire(cost: number, priority: GmailRequestPriority, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.capacity) {
      return Promise.reject(new Error(`Gmail request cost ${cost} exceeds limiter capacity`))
    }
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'))

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        id: this.nextWaiterId++,
        cost,
        priority,
        enqueuedAt: this.time.now(),
        resolve,
        reject,
        signal
      }
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          reject(signal.reason ?? new Error('request aborted'))
          this.reschedule()
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
      this.reschedule()
    })
  }

  snapshot(): GmailQuotaMetrics {
    return { ...this.metrics }
  }

  private reschedule(): void {
    if (this.timer !== null) {
      this.time.timers.clearTimeout(this.timer)
      this.timer = null
    }
    this.refill()

    for (;;) {
      const waiter = this.nextEligibleWaiter()
      if (!waiter) break
      const index = this.waiters.indexOf(waiter)
      this.waiters.splice(index, 1)
      this.tokens -= waiter.cost
      waiter.signal?.removeEventListener('abort', waiter.abort as () => void)
      this.metrics = {
        requests: this.metrics.requests + 1,
        units: this.metrics.units + waiter.cost,
        waitMs: this.metrics.waitMs + Math.max(0, this.time.now() - waiter.enqueuedAt)
      }
      waiter.resolve()
    }

    if (this.waiters.length === 0) return
    const delayMs = Math.min(...this.waiters.map((waiter) => this.delayFor(waiter)))
    this.timer = this.time.timers.setTimeout(
      () => {
        this.timer = null
        this.reschedule()
      },
      Math.max(1, delayMs)
    )
  }

  private refill(): void {
    const now = this.time.now()
    const elapsed = Math.max(0, now - this.refilledAt)
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.refilledAt = now
  }

  private nextEligibleWaiter(): Waiter | undefined {
    for (const priority of PRIORITIES) {
      const waiter = this.waiters.find(
        (candidate) =>
          candidate.priority === priority && this.tokens - candidate.cost >= this.reserveFor(candidate)
      )
      if (waiter) return waiter
    }
    return undefined
  }

  private delayFor(waiter: Waiter): number {
    const required = waiter.cost + this.reserveFor(waiter)
    return Math.ceil(Math.max(0, required - this.tokens) / this.refillPerMs)
  }

  private reserveFor(waiter: Waiter): number {
    // A deliberately low project quota must slow background work, not deadlock
    // it because the default reserve is larger than the whole bucket.
    return Math.min(this.reservedUnits[waiter.priority], this.capacity - waiter.cost)
  }
}

export function quotaMethod(method: string, path: string): GmailQuotaMethod {
  if (path === '/profile') return 'getProfile'
  if (path === '/history') return 'history.list'
  if (path === '/labels') return 'labels.list'
  if (path === '/drafts/send') return 'drafts.send'
  if (path === '/drafts') return method === 'GET' ? 'drafts.list' : 'drafts.create'
  if (/^\/drafts\/[^/]+$/.test(path)) {
    if (method === 'GET') return 'drafts.get'
    if (method === 'DELETE') return 'drafts.delete'
    return 'drafts.update'
  }
  if (path === '/messages') return 'messages.list'
  if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(path)) return 'messages.attachments.get'
  if (/^\/messages\/[^/]+$/.test(path)) return 'messages.get'
  if (path === '/threads') return 'threads.list'
  if (/^\/threads\/[^/]+\/modify$/.test(path)) return 'threads.modify'
  if (/^\/threads\/[^/]+\/trash$/.test(path)) return 'threads.trash'
  if (/^\/threads\/[^/]+\/untrash$/.test(path)) return 'threads.untrash'
  if (/^\/threads\/[^/]+$/.test(path)) return 'threads.get'
  throw new Error(`Missing Gmail quota cost for ${method} ${path}`)
}
