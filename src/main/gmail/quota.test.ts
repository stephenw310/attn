import { describe, expect, it } from 'vitest'
import type { SchedulerTime, TimerHandle } from '../time'
import { GMAIL_QUOTA_UNITS, GmailQuotaLimiter, quotaMethod } from './quota'

class ManualTime implements SchedulerTime {
  private current = 0
  private nextId = 1
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

  nextDelay(): number | undefined {
    const next = [...this.scheduled.values()].sort((left, right) => left.at - right.at)[0]
    return next ? next.at - this.current : undefined
  }

  advance(ms: number): void {
    this.current += ms
    const due = [...this.scheduled.entries()]
      .filter(([, timer]) => timer.at <= this.current)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [id, timer] of due) {
      this.scheduled.delete(id)
      timer.callback()
    }
  }
}

describe('Gmail weighted quota scheduling', () => {
  it('charges the current documented cost for every Gmail method Attn calls', () => {
    const methods = [
      ['GET', '/profile', 'getProfile', 1],
      ['GET', '/history', 'history.list', 2],
      ['GET', '/labels', 'labels.list', 1],
      ['GET', '/threads', 'threads.list', 10],
      ['GET', '/threads/t1', 'threads.get', 40],
      ['POST', '/threads/t1/modify', 'threads.modify', 10],
      ['POST', '/threads/t1/trash', 'threads.trash', 20],
      ['POST', '/threads/t1/untrash', 'threads.untrash', 10],
      ['GET', '/messages', 'messages.list', 5],
      ['GET', '/messages/m1', 'messages.get', 20],
      ['GET', '/messages/m1/attachments/a1', 'messages.attachments.get', 20],
      ['GET', '/drafts', 'drafts.list', 5],
      ['POST', '/drafts', 'drafts.create', 10],
      ['GET', '/drafts/d1', 'drafts.get', 20],
      ['PUT', '/drafts/d1', 'drafts.update', 15],
      ['DELETE', '/drafts/d1', 'drafts.delete', 10],
      ['POST', '/drafts/send', 'drafts.send', 100]
    ] as const
    for (const [httpMethod, path, quotaName, cost] of methods) {
      expect(quotaMethod(httpMethod, path)).toBe(quotaName)
      expect(GMAIL_QUOTA_UNITS[quotaName]).toBe(cost)
    }
    expect(() => quotaMethod('POST', '/unknown')).toThrow('Missing Gmail quota cost')
  })

  it('still drains background work when the configured minute rate is below the default reserve', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter({ unitsPerMinute: 60 }, { time })

    await limiter.acquire(40, 'background')
    let released = false
    const waiting = limiter.acquire(40, 'background').then(() => {
      released = true
    })
    expect(released).toBe(false)

    time.advance(40_000)
    await waiting
    expect(released).toBe(true)
  })

  it('paces by weighted cost while retaining the configured background reserve', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      {
        unitsPerMinute: 600,
        capacity: 120,
        reservedUnits: { send: 0, action: 20, polling: 30, foreground: 35, background: 40 }
      },
      { time }
    )

    await limiter.acquire(80, 'background')
    let backgroundReleased = false
    const background = limiter.acquire(40, 'background').then(() => {
      backgroundReleased = true
    })
    await Promise.resolve()
    expect(backgroundReleased).toBe(false)
    expect(time.nextDelay()).toBe(4_000)

    time.advance(4_000)
    await background
    expect(backgroundReleased).toBe(true)
    expect(limiter.snapshot()).toEqual({ requests: 2, units: 120, waitMs: 4_000 })
  })

  it('lets sends and queued actions pass a waiting background request first', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      {
        unitsPerMinute: 600,
        capacity: 120,
        reservedUnits: { send: 0, action: 20, polling: 30, foreground: 35, background: 40 }
      },
      { time }
    )
    await limiter.acquire(80, 'background')

    const order: string[] = []
    const background = limiter.acquire(40, 'background').then(() => order.push('background'))
    const action = limiter.acquire(10, 'action').then(() => order.push('action'))
    const send = limiter.acquire(30, 'send').then(() => order.push('send'))
    await Promise.resolve()
    expect(order).toEqual(['action', 'send'])

    expect(time.nextDelay()).toBe(8_000)
    time.advance(8_000)
    await Promise.all([background, action, send])
    expect(order).toEqual(['action', 'send', 'background'])
  })

  it('removes an aborted waiter without consuming quota', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      {
        unitsPerMinute: 600,
        capacity: 100,
        reservedUnits: { background: 50 }
      },
      { time }
    )
    await limiter.acquire(50, 'background')
    const controller = new AbortController()
    const waiting = limiter.acquire(50, 'background', controller.signal)
    controller.abort(new Error('shutdown'))

    await expect(waiting).rejects.toThrow('shutdown')
    expect(limiter.snapshot()).toEqual({ requests: 1, units: 50, waitMs: 0 })
    expect(time.nextDelay()).toBeUndefined()
  })
})
