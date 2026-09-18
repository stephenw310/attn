import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_SETTINGS_DEFAULTS, type AiStoredSettings } from '../../shared/ai'
import type { TypeSafeTransport } from '../ai/typesafeClient'
import { type Db, openDatabase } from '../db'
import { descriptionHash, saveSplit, splitRevision } from '../splits'
import type { SchedulerTime, TimerHandle } from '../time'
import { SplitTriage, type SplitTriageOptions } from './splitTriage'
import { SPLIT_TRIAGE_BROADCAST_INTERVAL_MS } from './tuning'

/**
 * Deterministic clock. The pass, the client deadline and every retry wait ride
 * it, so a test fires exactly the timers it means to.
 */
class ManualTimers {
  private next = 1
  private pending = new Map<number, { callback: () => void; delayMs: number }>()
  nowMs = 1_000

  readonly time: SchedulerTime = {
    now: () => this.nowMs,
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = this.next++
        this.pending.set(id, { callback, delayMs })
        return id as unknown as TimerHandle
      },
      clearTimeout: (handle) => {
        this.pending.delete(handle as unknown as number)
      }
    }
  }

  fire(maxDelayMs: number): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.delayMs <= maxDelayMs) {
        this.pending.delete(id)
        entry.callback()
      }
    }
  }

  get armed(): number {
    return this.pending.size
  }
}

/** Settle the pass's promise chain without advancing the injected clock. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
}

interface RecordedRequest {
  state: { subject?: string }
  questions: Record<string, { instructions: string }>
}

/** A transport that answers every question with the probability the test picks. */
function scriptedTransport(
  answer: (subject: string, instructions: string) => number,
  recorded: RecordedRequest[]
): TypeSafeTransport {
  return (_url, init) => {
    const body = JSON.parse(String(init.body)) as RecordedRequest
    recorded.push(body)
    const answers: Record<string, { type: string; noul: number }> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] = { type: 'noul', noul: answer(body.state.subject ?? '', question.instructions) }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ model: 'jev-latest', answers })
    } as unknown as Response)
  }
}

function failingTransport(status: number, headers: Record<string, string> = {}): TypeSafeTransport {
  return () =>
    Promise.resolve({
      ok: false,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => ({})
    } as unknown as Response)
}

describe('split triage pass', () => {
  let db: Db
  let timers: ManualTimers
  let settings: AiStoredSettings
  let key: string | null
  let recorded: RecordedRequest[]
  let broadcasts: number
  let late: string[][]

  const insertThread = (
    accountId: string,
    threadId: string,
    subject: string,
    messages: { id: string; at: number; body?: string }[]
  ): void => {
    db.prepare(
      `INSERT INTO threads (account_id, id, subject, snippet, last_msg_at, from_display, is_unread,
                            is_inbox_visible)
       VALUES (?, ?, ?, '', ?, 'Ada', 1, 1)`
    ).run(accountId, threadId, subject, messages.at(-1)?.at ?? 0)
    db.prepare(
      `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, 'INBOX')`
    ).run(accountId, threadId)
    const insert = db.prepare(
      `INSERT INTO messages
         (account_id, id, thread_id, from_name, from_email, snippet, internal_date, body_text,
          recipients_json, attachments_json, labels_json)
       VALUES (?, ?, ?, 'Ada', 'ada@example.com', 'snippet', ?, ?, ?, '[]', '["INBOX"]')`
    )
    for (const message of messages) {
      insert.run(
        accountId,
        message.id,
        threadId,
        message.at,
        message.body ?? 'body text',
        JSON.stringify({ to: [{ email: 'me@test' }], cc: [], bcc: [], replyTo: [] })
      )
    }
  }

  const describedSplit = (accountId: string, name: string, description: string): string => {
    const state = saveSplit(db, accountId, { name, mode: 'description', description, notify: true })
    const rule = state.splits.find((split) => split.name === name)
    if (!rule) throw new Error(`missing split ${name}`)
    return rule.id
  }

  const makeTriage = (
    accountId: string,
    transport: TypeSafeTransport,
    overrides: Partial<SplitTriageOptions> = {}
  ): SplitTriage =>
    new SplitTriage({
      db,
      accountId,
      time: timers.time,
      transport: () => transport,
      readSettings: () => settings,
      triageKey: () => key,
      isActive: () => true,
      onAssignmentsChanged: () => {
        broadcasts++
      },
      onLateJudgment: (threadIds) => {
        late.push(threadIds)
      },
      ...overrides
    })

  const judgments = (accountId: string): Record<string, unknown>[] =>
    db
      .prepare('SELECT * FROM split_judgments WHERE account_id = ? ORDER BY thread_id, split_id')
      .all(accountId) as Record<string, unknown>[]

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare("INSERT INTO accounts (id, email) VALUES ('account', 'me@test')").run()
    db.prepare("INSERT INTO accounts (id, email) VALUES ('other', 'other@test')").run()
    timers = new ManualTimers()
    settings = { ...AI_SETTINGS_DEFAULTS, triageEnabled: true }
    key = 'ts-secret'
    recorded = []
    broadcasts = 0
    late = []
  })

  afterEach(() => db.close())

  it('asks nothing while consent, the key, or a described split is missing', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const transport = scriptedTransport(() => 0.9, recorded)

    settings = { ...settings, triageEnabled: false }
    const disabled = makeTriage('account', transport)
    disabled.kick()
    await disabled.settled()
    expect(recorded).toHaveLength(0)

    settings = { ...settings, triageEnabled: true }
    key = null
    const keyless = makeTriage('account', transport)
    keyless.kick()
    await keyless.settled()
    expect(recorded).toHaveLength(0)

    key = 'ts-secret'
    db.prepare("DELETE FROM split_rules WHERE account_id = 'account' AND kind = 'custom'").run()
    const ruleless = makeTriage('account', transport)
    ruleless.kick()
    await ruleless.settled()
    expect(recorded).toHaveLength(0)
    expect(judgments('account')).toHaveLength(0)
  })

  it('writes one judgment per described split, keyed by description and latest message', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    insertThread('account', 't-2', 'Lunch plans', [{ id: 'm-2', at: 90 }])
    const invoices = describedSplit('account', 'Invoices', 'Bills I have to pay')
    const triage = makeTriage(
      'account',
      scriptedTransport((subject) => (subject.includes('invoice') ? 0.93 : 0.04), recorded)
    )

    triage.kick()
    await triage.settled()

    expect(recorded).toHaveLength(2)
    expect(judgments('account')).toEqual([
      {
        account_id: 'account',
        thread_id: 't-1',
        split_id: invoices,
        description_hash: descriptionHash('Bills I have to pay'),
        evidence_key: 'm-1',
        probability: 0.93,
        judged_at: timers.nowMs
      },
      {
        account_id: 'account',
        thread_id: 't-2',
        split_id: invoices,
        description_hash: descriptionHash('Bills I have to pay'),
        evidence_key: 'm-2',
        probability: 0.04,
        judged_at: timers.nowMs
      }
    ])
    // One thread moved, so the pass bumps the revision once and says so once.
    expect(broadcasts).toBe(1)

    // Re-running finds nothing: the anti-join is satisfied for both threads.
    const before = recorded.length
    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(before)
  })

  it('re-judges a thread when a new message arrives', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )
    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(1)

    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                             body_text, recipients_json, attachments_json, labels_json)
       VALUES ('account', 'm-2', 't-1', 'Grace', 'grace@example.com', 's', 200, 'reply', '{}', '[]', '[]')`
    ).run()

    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(2)
    expect(judgments('account')[0]?.evidence_key).toBe('m-2')
  })

  it('bumps the split revision only when an assignment actually changed', async () => {
    insertThread('account', 't-1', 'Lunch plans', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const revisionBefore = splitRevision(db, 'account')
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.05, recorded)
    )

    triage.kick()
    await triage.settled()
    expect(judgments('account')).toHaveLength(1)
    expect(broadcasts).toBe(0)
    expect(splitRevision(db, 'account')).toBe(revisionBefore)
  })

  it('throttles the broadcast while a long pass keeps moving threads', async () => {
    for (let index = 0; index < 4; index++) {
      insertThread('account', `t-${index}`, 'Q3 invoice', [{ id: `m-${index}`, at: 100 - index }])
    }
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    // Each answered request advances the clock past the throttle window.
    const transport: TypeSafeTransport = (url, init) => {
      timers.nowMs += SPLIT_TRIAGE_BROADCAST_INTERVAL_MS + 1
      return scriptedTransport(() => 0.9, recorded)(url, init)
    }
    const triage = makeTriage('account', transport)
    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(4)
    // Four moves, but the flushes are spaced: strictly fewer bumps than moves.
    expect(broadcasts).toBeGreaterThan(0)
    expect(broadcasts).toBeLessThan(4)
  })

  it('stops on a refused key and stays stopped until the key changes', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    insertThread('account', 't-2', 'Another invoice', [{ id: 'm-2', at: 90 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const transport: TypeSafeTransport = (url, init) => {
      attempts++
      return failingTransport(401)(url, init)
    }
    const warnings: string[] = []
    const triage = makeTriage('account', transport, {
      log: (_level, message) => {
        warnings.push(message)
      }
    })

    triage.kick()
    await triage.settled()
    const afterFirst = attempts
    expect(afterFirst).toBeGreaterThan(0)
    expect(judgments('account')).toHaveLength(0)
    expect(warnings.some((line) => line.includes('HTTP 401'))).toBe(true)

    triage.kick()
    await triage.settled()
    expect(attempts).toBe(afterFirst)

    key = 'ts-replacement'
    triage.kick()
    await triage.settled()
    expect(attempts).toBeGreaterThan(afterFirst)
  })

  it('waits out rate limiting and then judges the thread', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const transport: TypeSafeTransport = (url, init) => {
      attempts++
      if (attempts === 1) return failingTransport(429, { 'retry-after': '2' })(url, init)
      return scriptedTransport(() => 0.9, recorded)(url, init)
    }
    const triage = makeTriage('account', transport)

    triage.kick()
    await flush()
    // The pass is asleep on the Retry-After, not spinning.
    expect(judgments('account')).toHaveLength(0)
    expect(attempts).toBe(1)
    timers.fire(2_000)
    await triage.settled()
    expect(attempts).toBe(2)
    expect(judgments('account')).toHaveLength(1)
  })

  it('never mixes one account judgments into another account', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    insertThread('other', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    describedSplit('other', 'Receipts', 'Proof of payment')
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )

    triage.kick()
    await triage.settled()

    expect(judgments('account')).toHaveLength(1)
    expect(judgments('other')).toHaveLength(0)
    expect(recorded).toHaveLength(1)
  })

  it('resolves judgeNow at its deadline and reports the late judgment afterwards', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const transport: TypeSafeTransport = (url, init) =>
      new Promise<Response>((resolve) => {
        held.push(() => void scriptedTransport(() => 0.9, recorded)(url, init).then(resolve))
      })
    const triage = makeTriage('account', transport)

    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(false)

    timers.fire(2_000)
    await waiting
    expect(resolved).toBe(true)
    expect(late).toEqual([])
    expect(judgments('account')).toHaveLength(0)

    for (const release of held) release()
    await triage.settled()
    expect(judgments('account')).toHaveLength(1)
    expect(late).toEqual([['t-1']])
  })

  it('judges a waiting thread ahead of the backlog it is already working through', async () => {
    // Twelve unjudged threads, all newer than the arrival, so the queue order
    // alone would put the arrival last.
    for (let index = 0; index < 12; index++) {
      insertThread('account', `t-backlog-${index}`, 'Q3 invoice', [
        { id: `m-backlog-${index}`, at: 500 + index }
      ])
    }
    insertThread('account', 't-arrival', 'Dinner Friday', [{ id: 'm-arrival', at: 1 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let triage: SplitTriage | null = null
    let waiting: Promise<void> | null = null
    const answer = scriptedTransport(() => 0.5, recorded)
    const transport: TypeSafeTransport = (url, init) => {
      // The arrival turns up once the pass is already draining the backlog.
      if (recorded.length === 2 && !waiting && triage) waiting = triage.judgeNow(['t-arrival'], 2_000)
      return answer(url, init)
    }
    triage = makeTriage('account', transport)

    triage.kick()
    await triage.settled()
    await waiting

    const subjects = recorded.map((request) => request.state.subject ?? '')
    expect(subjects).toHaveLength(13)
    const arrival = subjects.indexOf('Dinner Friday')
    // Not last: the wait would have expired long before its turn came up.
    expect(arrival).toBeGreaterThan(0)
    expect(arrival).toBeLessThan(8)
  })

  it('resolves judgeNow without a request when the gate is closed', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    settings = { ...settings, triageEnabled: false }
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )
    await triage.judgeNow(['t-1'], 2_000)
    expect(recorded).toHaveLength(0)
  })

  it('stops for shutdown and refuses to start again', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )
    await triage.stop()
    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(0)
    expect(timers.armed).toBe(0)
  })
})
