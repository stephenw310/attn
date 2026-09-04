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
      ['GET', '/messages', 'messages.list', 5],
      ['GET', '/messages/m1', 'messages.get', 20],
      ['GET', '/messages/m1/attachments/a1', 'messages.attachments.get', 20],
      ['GET', '/settings/sendAs/me%40example.com', 'settings.sendAs.get', 1],
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

    time.advance(60_000)
    await waiting
    expect(released).toBe(true)
  })

  it('still admits the most expensive request under a quota smaller than its cost', async () => {
    const time = new ManualTime()
    // A deliberately small project quota must slow sending down, not make
    // `drafts.send` (100 units) unschedulable for the life of the client.
    const limiter = new GmailQuotaLimiter({ unitsPerMinute: 60 }, { time })

    await expect(limiter.acquire(GMAIL_QUOTA_UNITS['drafts.send'], 'send')).resolves.toBeUndefined()

    let released = false
    const waiting = limiter.acquire(GMAIL_QUOTA_UNITS['drafts.send'], 'send').then(() => {
      released = true
    })
    expect(released).toBe(false)
    // Paced, not refused: the next send waits out the configured 60 units a
    // minute rather than being rejected outright.
    for (let minute = 0; minute < 3 && !released; minute++) {
      time.advance(60_000)
      await Promise.resolve()
    }
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

  it('never admits more than the configured units inside a rolling minute', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      { unitsPerMinute: 600, capacity: 120, reservedUnits: { send: 0 } },
      { time }
    )

    await limiter.acquire(120, 'send')
    for (let index = 0; index < 4; index++) {
      time.advance(12_000)
      await limiter.acquire(120, 'send')
    }

    let released = false
    const waiting = limiter.acquire(120, 'send').then(() => {
      released = true
    })
    time.advance(11_999)
    await Promise.resolve()
    expect(released).toBe(false)

    time.advance(1)
    await waiting
    expect(released).toBe(true)
    expect(limiter.snapshot()).toEqual({ requests: 6, units: 720, waitMs: 12_000 })
  })

  it('uses a bounded default burst instead of starting with a full minute of quota', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter({ unitsPerMinute: 6_000, reservedUnits: { send: 0 } }, { time })
    for (let index = 0; index < 6; index++) await limiter.acquire(100, 'send')

    let released = false
    const waiting = limiter.acquire(100, 'send').then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    time.advance(1_000)
    await waiting
    expect(released).toBe(true)
  })

  it('keeps FIFO order inside one priority band when request costs differ', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      { unitsPerMinute: 600, capacity: 100, reservedUnits: { foreground: 0 } },
      { time }
    )
    await limiter.acquire(100, 'foreground')

    const order: string[] = []
    const expensive = limiter.acquire(80, 'foreground').then(() => order.push('expensive'))
    const cheap = limiter.acquire(10, 'foreground').then(() => order.push('cheap'))

    time.advance(1_000)
    await Promise.resolve()
    expect(order).toEqual([])

    time.advance(7_000)
    await expensive
    expect(order).toEqual(['expensive'])

    time.advance(1_000)
    await cheap
    expect(order).toEqual(['expensive', 'cheap'])
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

  it('clears its timer and rejects queued and future work when disposed', async () => {
    const time = new ManualTime()
    const limiter = new GmailQuotaLimiter(
      { unitsPerMinute: 600, capacity: 100, reservedUnits: { background: 50 } },
      { time }
    )
    await limiter.acquire(50, 'background')
    const waiting = limiter.acquire(50, 'background')
    expect(time.nextDelay()).toBe(5_000)

    limiter.dispose(new Error('shutdown'))

    await expect(waiting).rejects.toThrow('shutdown')
    await expect(limiter.acquire(1, 'send')).rejects.toThrow('disposed')
    expect(time.nextDelay()).toBeUndefined()
  })
})
