import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from './db'
import { setFollowUpRecoveryPending } from './followUps'
import { SnoozeScheduler } from './scheduler'
import type { SchedulerTime, TimerHandle } from './time'

interface ArmedTimer {
  callback: () => void
  delayMs: number
}

interface Harness {
  scheduler: SnoozeScheduler
  handle: TimerHandle
  armed: ArmedTimer[]
  cleared: TimerHandle[]
  dueQueries: number[]
  advanceTo: (at: number) => void
}

/**
 * Stands in for the reminders table with nothing ever due, so `returnThreads`
 * short-circuits before it needs `transaction`/`run`. Teaching this fake to
 * return due rows means giving it those too.
 */
function harness(dueAt: number): Harness {
  const handle = {} as TimerHandle
  const armed: ArmedTimer[] = []
  const cleared: TimerHandle[] = []
  const dueQueries: number[] = []
  let now = 10_000

  const db = {
    prepare: (sql: string) => ({
      all: (_accountId: string, at: number) => {
        dueQueries.push(at)
        return []
      },
      get: () => (sql.includes('MIN(due)') ? { due: dueAt } : undefined)
    })
  } as unknown as Db

  const time: SchedulerTime = {
    now: () => now,
    timers: {
      setTimeout: (callback, delayMs) => {
        armed.push({ callback, delayMs })
        return handle
      },
      clearTimeout: (timer) => {
        cleared.push(timer)
      }
    }
  }

  const scheduler = new SnoozeScheduler(
    db,
    () => 'seed@attn.test',
    () => {},
    () => {},
    time
  )

  return {
    scheduler,
    handle,
    armed,
    cleared,
    dueQueries,
    advanceTo: (at) => {
      now = at
    }
  }
}

describe('snooze scheduler time seam', () => {
  it('arms and cancels through injected time without waiting on the wall clock', () => {
    const { scheduler, handle, armed, cleared } = harness(12_500)

    scheduler.start()
    expect(armed).toHaveLength(1)
    expect(armed[0].delayMs).toBe(2_500)

    scheduler.stop()
    expect(cleared).toEqual([handle])
  })

  it('re-checks due reminders when the armed timer fires', () => {
    const { scheduler, handle, armed, cleared, dueQueries, advanceTo } = harness(12_500)

    scheduler.start()
    // One due query per reminder kind (snooze, then eligible follow-ups).
    expect(dueQueries).toEqual([10_000, 10_000])

    // Firing the armed callback is the whole point of the seam: the undo-send
    // and outbox windows elapse here rather than in real time.
    advanceTo(12_500)
    armed[0].callback()

    expect(dueQueries).toEqual([10_000, 10_000, 12_500, 12_500])
    expect(cleared).toEqual([handle])
    expect(armed[1].delayMs).toBe(0)
  })

  it('records automatic returns explicitly in the action payload', () => {
    let pending = true
    const payloads: string[] = []
    const db = {
      prepare: (sql: string) => ({
        all: () => (sql.includes('SELECT thread_id FROM reminders') ? [{ thread_id: 'roadmap' }] : []),
        get: () => undefined,
        run: (...args: unknown[]) => {
          if (sql.includes("UPDATE reminders SET state = 'returned'")) {
            if (!pending) return { changes: 0 }
            pending = false
            return { changes: 1 }
          }
          if (sql.includes('INSERT INTO action_queue')) payloads.push(String(args[2]))
          return { changes: 1 }
        }
      }),
      transaction: (callback: () => void) => callback
    } as unknown as Db
    const scheduler = new SnoozeScheduler(
      db,
      () => 'seed@attn.test',
      () => {},
      () => {}
    )

    scheduler.refresh()

    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
      { add: ['INBOX'], remove: [], actionKind: 'snoozeReturn' }
    ])
  })
})

describe('follow-up scheduling against a real store (T35)', () => {
  const ACCOUNT = 'seed@attn.test'

  function followUpStore(): {
    db: Db
    scheduler: SnoozeScheduler
    now: () => number
    advance: (to: number) => void
    fire: () => void
    armedDelays: () => number[]
    announced: { changed: number; queueChanged: number }
  } {
    let now = 10_000
    const armed: ArmedTimer[] = []
    const time: SchedulerTime = {
      now: () => now,
      timers: {
        setTimeout: (callback, delayMs) => {
          armed.push({ callback, delayMs })
          return {} as TimerHandle
        },
        clearTimeout: () => {}
      }
    }
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(ACCOUNT, ACCOUNT)
    const announced = { changed: 0, queueChanged: 0 }
    const scheduler = new SnoozeScheduler(
      db,
      () => ACCOUNT,
      () => {
        announced.changed++
      },
      () => {
        announced.queueChanged++
      },
      time
    )
    return {
      db,
      scheduler,
      now: () => now,
      advance: (to) => {
        now = to
      },
      fire: () => armed.at(-1)?.callback(),
      armedDelays: () => armed.map((timer) => timer.delayMs),
      announced
    }
  }

  function insertFollowUp(
    db: Db,
    patch: { threadId?: string; dueAt: number; state?: string; originInternalDate?: number | null }
  ): void {
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
         origin_message_id, origin_rfc_message_id, origin_internal_date)
       VALUES (?, ?, 'follow_up', ?, ?, 'm-origin', '<origin@attn.test>', ?)`
    ).run(
      ACCOUNT,
      patch.threadId ?? 't-f',
      patch.dueAt,
      patch.state ?? 'pending',
      patch.originInternalDate === undefined ? 1 : patch.originInternalDate
    )
  }

  function insertSnooze(db: Db, threadId: string, dueAt: number): void {
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state) VALUES (?, ?, 'snooze', ?, 'pending')`
    ).run(ACCOUNT, threadId, dueAt)
  }

  function queueRows(db: Db): Array<{ thread_id: string; payload: string }> {
    return db.prepare('SELECT thread_id, payload FROM action_queue ORDER BY id').all() as Array<{
      thread_id: string
      payload: string
    }>
  }

  function reminderState(db: Db, threadId: string, kind: string): string | undefined {
    return (
      db
        .prepare('SELECT state FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = ?')
        .get(ACCOUNT, threadId, kind) as { state: string } | undefined
    )?.state
  }

  it('returns a due resolved follow-up: chip state, Inbox restore, one queued mutation', () => {
    const { db, scheduler } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000 })
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    expect(
      db.prepare("SELECT 1 FROM thread_labels WHERE thread_id = 't-f' AND label_id = 'INBOX'").get()
    ).toBeDefined()
    expect(queueRows(db).map((row) => JSON.parse(row.payload).actionKind)).toEqual(['followUpReturn'])
    // Re-fetching after return keeps it visible: a fresh refresh changes nothing.
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    expect(queueRows(db)).toHaveLength(1)
  })

  it('never fires an unresolved origin, and arms no timer for it', () => {
    const { db, scheduler, armedDelays } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000, originInternalDate: null })
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('pending')
    expect(armedDelays()).toEqual([])
  })

  it('a pending snooze wins: the follow-up defers and the timer arms for the snooze deadline', () => {
    const { db, scheduler, armedDelays } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000 })
    insertSnooze(db, 't-f', 15_000)
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('pending')
    expect(
      db.prepare("SELECT 1 FROM thread_labels WHERE thread_id = 't-f' AND label_id = 'INBOX'").get()
    ).toBeUndefined()
    // Armed for the snooze (15s − 10s), not the already-past follow-up.
    expect(armedDelays()).toEqual([5_000])
  })

  it('a snooze return settles an overdue follow-up in one transaction with one Inbox restoration', () => {
    const { db, scheduler, advance, fire } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000 })
    insertSnooze(db, 't-f', 15_000)
    scheduler.refresh()
    advance(15_000)
    fire()
    expect(reminderState(db, 't-f', 'snooze')).toBe('returned')
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    const rows = queueRows(db)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toMatchObject({ add: ['INBOX'], actionKind: 'snoozeReturn' })
  })

  it('both deadlines missed while closed settle once at startup', () => {
    const { db, scheduler } = followUpStore()
    insertFollowUp(db, { dueAt: 8_000 })
    insertSnooze(db, 't-f', 9_000)
    scheduler.start()
    expect(reminderState(db, 't-f', 'snooze')).toBe('returned')
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    expect(queueRows(db)).toHaveLength(1)
  })

  it('announces a wake once, re-arming in the same pass', () => {
    const { db, scheduler, announced } = followUpStore()
    insertSnooze(db, 't-f', 50_000)
    // Another reminder is already due; re-arming used to return it with a
    // second announcement on top of the wake's own.
    insertSnooze(db, 't-other', 9_000)

    expect(scheduler.wakeThread('t-f')).toBe(true)

    expect(reminderState(db, 't-f', 'snooze')).toBe('returned')
    expect(reminderState(db, 't-other', 'snooze')).toBe('returned')
    expect(announced).toEqual({ changed: 1, queueChanged: 1 })
  })

  it('a snooze wake settles the overdue follow-up with the snooze', () => {
    const { db, scheduler } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000 })
    insertSnooze(db, 't-f', 50_000)
    scheduler.wakeThread('t-f')
    expect(reminderState(db, 't-f', 'snooze')).toBe('returned')
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    expect(queueRows(db)).toHaveLength(1)
  })

  it('the persisted recovery guard defers follow-up returns until cleared', () => {
    const { db, scheduler } = followUpStore()
    insertFollowUp(db, { dueAt: 9_000 })
    setFollowUpRecoveryPending(db, ACCOUNT, true)
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('pending')
    setFollowUpRecoveryPending(db, ACCOUNT, false)
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
  })

  it('skips a second Inbox mutation when a snooze already restored the thread', () => {
    const { db, scheduler, advance, fire } = followUpStore()
    // Snooze returns first; the follow-up becomes due later.
    insertSnooze(db, 't-f', 9_000)
    insertFollowUp(db, { dueAt: 20_000 })
    scheduler.refresh()
    expect(reminderState(db, 't-f', 'snooze')).toBe('returned')
    expect(queueRows(db)).toHaveLength(1)
    advance(20_000)
    fire()
    expect(reminderState(db, 't-f', 'follow_up')).toBe('returned')
    // The thread already sits in Inbox from the snooze return: chip and
    // priority flip with no duplicate queued mutation.
    expect(queueRows(db)).toHaveLength(1)
  })
})
