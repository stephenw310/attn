import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_SETTINGS_DEFAULTS, type AiStoredSettings } from '../../shared/ai'
import type { TypeSafeTransport } from '../ai/typesafeClient'
import { type Db, openDatabase } from '../db'
import { deleteSplit, judgmentHash, saveSplit, splitRevision, splitTriageCounts } from '../splits'
import type { SchedulerTime, TimerHandle } from '../time'
import { deleteThread } from './persist'
import { type LateJudgment, SplitTriage, type SplitTriageOptions } from './splitTriage'
import {
  SPLIT_TRIAGE_BATCH_SIZE,
  SPLIT_TRIAGE_BROADCAST_INTERVAL_MS,
  SPLIT_TRIAGE_FAILURE_BACKOFF_MS,
  SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS,
  SPLIT_TRIAGE_MAX_ATTEMPTS,
  SPLIT_TRIAGE_OFFLINE_RETRY_MS,
  SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS
} from './tuning'

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
  state: { threads: { subject?: string }[] }
  questions: Record<string, { instructions: string }>
}

/** The subjects one request carried, in the order they were packed. */
function subjectsOf(request: RecordedRequest): string[] {
  return request.state.threads.map((thread) => thread.subject ?? '')
}

/**
 * A transport that answers every question with the probability the test picks,
 * against the conversation the question id names (`t2_s0` is `threads[2]`).
 */
function scriptedTransport(
  answer: (subject: string, instructions: string) => number,
  recorded: RecordedRequest[]
): TypeSafeTransport {
  return (_url, init) => {
    const body = JSON.parse(String(init.body)) as RecordedRequest
    recorded.push(body)
    const answers: Record<string, { type: string; noul: number }> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      const threadIndex = Number(/^t(\d+)_s\d+$/.exec(id)?.[1] ?? 0)
      const subject = body.state.threads[threadIndex]?.subject ?? ''
      answers[id] = { type: 'noul', noul: answer(subject, question.instructions) }
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
  let late: LateJudgment[][]

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

  /** A reply landing on a stored conversation: evidence no judgment has read. */
  const appendMessage = (accountId: string, threadId: string, messageId: string, at: number): void => {
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                             body_text, recipients_json, attachments_json, labels_json)
       VALUES (?, ?, ?, 'Grace', 'grace@example.com', 's', ?, 'reply', '{}', '[]', '["INBOX"]')`
    ).run(accountId, messageId, threadId, at)
  }

  /** A transport that hands every request back to the test to release. */
  const heldTransport = (
    held: Array<() => void>,
    probability: (request: number) => number
  ): TypeSafeTransport => {
    let requests = 0
    return (url, init) => {
      const answer = scriptedTransport(() => probability(++requests), recorded)
      return new Promise<Response>((resolve) => {
        held.push(() => void answer(url, init).then(resolve))
      })
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
      onLateJudgment: (threads) => {
        late.push(threads)
      },
      ...overrides
    })

  /** Drive the queued conversations to their attempt cap through the ladder. */
  const exhaustAttempts = async (triage: SplitTriage): Promise<void> => {
    triage.kick()
    await triage.settled()
    for (const step of SPLIT_TRIAGE_FAILURE_BACKOFF_MS.slice(0, SPLIT_TRIAGE_MAX_ATTEMPTS - 1)) {
      timers.nowMs += step
      timers.fire(step)
      await triage.settled()
    }
  }

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

    // Both conversations rode one request, each with its own question.
    expect(recorded).toHaveLength(1)
    expect(subjectsOf(recorded[0])).toEqual(['Q3 invoice', 'Lunch plans'])
    expect(Object.keys(recorded[0].questions)).toEqual(['t0_s0', 't1_s0'])
    expect(judgments('account')).toEqual([
      {
        account_id: 'account',
        thread_id: 't-1',
        split_id: invoices,
        description_hash: judgmentHash('Invoices', 'Bills I have to pay'),
        evidence_key: 'm-1',
        probability: 0.93,
        judged_at: timers.nowMs
      },
      {
        account_id: 'account',
        thread_id: 't-2',
        split_id: invoices,
        description_hash: judgmentHash('Invoices', 'Bills I have to pay'),
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
    for (let index = 0; index < 25; index++) {
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
    // Ten conversations per request: three requests, not twenty-five.
    expect(recorded).toHaveLength(3)
    expect(recorded.map((request) => request.state.threads.length)).toEqual([10, 10, 5])
    expect(judgments('account')).toHaveLength(25)
    // Twenty-five moves, but the flushes are spaced: far fewer bumps than moves.
    expect(broadcasts).toBeGreaterThan(0)
    expect(broadcasts).toBeLessThan(25)
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

  it('does not retry the rate-limited pack when consent is withdrawn during the wait', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return attempts === 1 ? failingTransport(429, { 'retry-after': '2' })(url, init) : answer(url, init)
    })

    triage.kick()
    await flush()
    expect(attempts).toBe(1)

    // The user turns smart splits off while the pass sleeps on Retry-After.
    settings = { ...settings, triageEnabled: false }
    timers.fire(2_000)
    await triage.settled()

    // The captured gate never sends a second request, and the pass is over.
    expect(attempts).toBe(1)
    expect(judgments('account')).toHaveLength(0)
    // Unjudged, but no attempt charged: nothing is waiting to ask again.
    expect(timers.armed).toBe(0)
  })

  it('retries a rejected pack one conversation at a time', async () => {
    for (let index = 0; index < 3; index++) {
      insertThread('account', `t-${index}`, 'Q3 invoice', [{ id: `m-${index}`, at: 100 - index }])
    }
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const warnings: string[] = []
    const triage = makeTriage(
      'account',
      (url, init) => {
        attempts++
        return failingTransport(422)(url, init)
      },
      {
        log: (_level, message) => {
          warnings.push(message)
        }
      }
    )

    triage.kick()
    await triage.settled()

    // The pack, then each conversation on its own: a service that rejects one
    // conversation must not cost the other two their judgment.
    expect(attempts).toBe(4)
    expect(judgments('account')).toHaveLength(0)
    expect(warnings).toEqual([
      '[triage] smart splits request was rejected (HTTP 422); retrying 3 conversations one at a time',
      '[triage] smart splits request was rejected (HTTP 422); skipping 1 conversation',
      '[triage] smart splits request was rejected (HTTP 422); skipping 1 conversation',
      '[triage] smart splits request was rejected (HTTP 422); skipping 1 conversation'
    ])
  })

  it('judges the rest of a pack the service rejects for one conversation', async () => {
    const poison = 'Lone surrogate'
    for (let index = 0; index < 9; index++) {
      insertThread('account', `t-${index}`, 'Q3 invoice', [{ id: `m-${index}`, at: 200 - index }])
    }
    insertThread('account', 't-poison', poison, [{ id: 'm-poison', at: 150 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const warnings: string[] = []
    const packed: string[][] = []
    const answer = scriptedTransport(() => 0.9, recorded)
    const transport: TypeSafeTransport = (url, init) => {
      attempts++
      const body = JSON.parse(String(init.body)) as RecordedRequest
      packed.push(subjectsOf(body))
      if (subjectsOf(body).includes(poison)) return failingTransport(400)(url, init)
      return answer(url, init)
    }
    const triage = makeTriage('account', transport, {
      log: (_level, message) => {
        warnings.push(message)
      }
    })

    triage.kick()
    await triage.settled()

    // One rejected pack, then ten single-conversation requests.
    expect(attempts).toBe(11)
    expect(judgments('account')).toHaveLength(9)
    expect(judgments('account').map((row) => row.thread_id)).not.toContain('t-poison')
    expect(warnings[0]).toBe(
      '[triage] smart splits request was rejected (HTTP 400); retrying 10 conversations one at a time'
    )
    // Only the rejected conversation was charged, so only it is waiting.
    expect(timers.armed).toBe(1)
    const asked = attempts
    triage.kick()
    await triage.settled()
    expect(attempts).toBe(asked)

    timers.nowMs += SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0]
    timers.fire(SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0])
    await triage.settled()
    // Its second attempt carried that conversation alone; the other nine are answered.
    expect(attempts).toBe(asked + 1)
    expect(packed.at(-1)).toEqual([poison])
  })

  it('retries a rejected conversation after its backoff and judges it', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return attempts === 1 ? failingTransport(400)(url, init) : answer(url, init)
    })

    triage.kick()
    await triage.settled()
    expect(attempts).toBe(1)
    expect(judgments('account')).toHaveLength(0)
    // The pass armed its own retry rather than waiting for the next mail change.
    expect(timers.armed).toBe(1)

    timers.nowMs += SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0]
    timers.fire(SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0])
    await triage.settled()
    expect(attempts).toBe(2)
    expect(judgments('account')).toHaveLength(1)
    expect(triage.failedThreadIds().size).toBe(0)
    expect(timers.armed).toBe(0)
  })

  it('gives up on a conversation at its attempt cap and takes it back on a retry', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    let rejecting = true
    const warnings: string[] = []
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage(
      'account',
      (url, init) => {
        attempts++
        return rejecting ? failingTransport(400)(url, init) : answer(url, init)
      },
      {
        log: (_level, message) => {
          warnings.push(message)
        }
      }
    )

    await exhaustAttempts(triage)

    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS)
    expect([...triage.failedThreadIds()]).toEqual(['t-1'])
    expect(triage.failedCauses()).toEqual(['rejected'])
    expect(warnings).toContain('[triage] gave up on conversation t-1 after 3 attempts')
    // It has left the queue: nothing is waiting, and a kick asks nothing.
    expect(timers.armed).toBe(0)
    triage.kick()
    await triage.settled()
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS)

    rejecting = false
    triage.retryFailed()
    await triage.settled()
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS + 1)
    expect(triage.failedThreadIds().size).toBe(0)
    expect(judgments('account')).toHaveLength(1)
  })

  it('judges a conversation past its cap again once a new message arrives', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    let rejecting = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return rejecting ? failingTransport(400)(url, init) : answer(url, init)
    })

    await exhaustAttempts(triage)
    expect([...triage.failedThreadIds()]).toEqual(['t-1'])

    // The reply is evidence none of the failed attempts read.
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                             body_text, recipients_json, attachments_json, labels_json)
       VALUES ('account', 'm-2', 't-1', 'Grace', 'grace@example.com', 's', 200, 'reply', '{}', '[]', '[]')`
    ).run()
    // The record answered for the old message, so it no longer applies.
    expect(triage.failedThreadIds().size).toBe(0)
    expect(triage.failedCauses()).toEqual([])

    rejecting = false
    triage.kick()
    await triage.settled()
    // Judged on an ordinary pass, with no user retry.
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS + 1)
    expect(judgments('account')).toHaveLength(1)
    expect(judgments('account')[0]?.evidence_key).toBe('m-2')
  })

  it('judges a conversation past its cap again once the description changes', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    const invoices = describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    let rejecting = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return rejecting ? failingTransport(400)(url, init) : answer(url, init)
    })

    await exhaustAttempts(triage)
    expect([...triage.failedThreadIds()]).toEqual(['t-1'])

    const edited = 'Bills and receipts I have to file'
    saveSplit(db, 'account', {
      id: invoices,
      name: 'Invoices',
      mode: 'description',
      description: edited,
      notify: true
    })
    // The record answered a question the user no longer asks.
    expect(triage.failedThreadIds().size).toBe(0)

    rejecting = false
    triage.kick()
    await triage.settled()
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS + 1)
    expect(judgments('account')).toHaveLength(1)
    expect(judgments('account')[0]?.description_hash).toBe(judgmentHash('Invoices', edited))
  })

  it('charges the same budget when the rate-limit ladder runs out', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return failingTransport(429)(url, init)
    })

    triage.kick()
    // The ladder doubles from a second, so each wait needs its own tick.
    for (let step = 0; step < SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS; step++) {
      await flush()
      timers.nowMs += 32_000
      timers.fire(32_000)
    }
    await triage.settled()

    // Every ladder step rode one request, and the conversation then waits on
    // the same per-conversation backoff a rejected one gets.
    expect(attempts).toBe(SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS)
    expect(judgments('account')).toHaveLength(0)
    expect(triage.failedThreadIds().size).toBe(0)
    expect(timers.armed).toBe(1)
    timers.nowMs += SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0]
    timers.fire(SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0])
    await flush()
    expect(attempts).toBe(SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS + 1)
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
    // The report names the message the judgment answered for, so the caller
    // can check it is still the arrival a notification would be about.
    expect(late).toEqual([[{ threadId: 't-1', messageId: 'm-1' }]])
  })

  it('holds a priority wait open until the message it asked about is judged', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, (request) => (request === 1 ? 0.1 : 0.9))
    )

    triage.kick()
    await flush()
    expect(held).toHaveLength(1)

    // A reply lands while the pack that reads m-1 is still in flight, and the
    // notification path asks for a judgment of that reply.
    appendMessage('account', 't-1', 'm-2', 200)
    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()

    held[0]()
    await flush()
    // The answer for m-1 is stored, but it answers the message before the one
    // the caller waits for, so the wait stays open and nothing is reported late.
    expect(judgments('account')[0]?.evidence_key).toBe('m-1')
    expect(resolved).toBe(false)
    expect(late).toEqual([])

    // The thread is still pending, so the same pass asks about m-2 next.
    expect(held).toHaveLength(2)
    held[1]()
    await waiting
    await triage.settled()
    expect(resolved).toBe(true)
    expect(judgments('account')).toHaveLength(1)
    expect(judgments('account')[0]?.evidence_key).toBe('m-2')
    expect(judgments('account')[0]?.probability).toBe(0.9)
    expect(late).toEqual([])
  })

  it('reports the late judgment of the message the caller waited for, not the one before it', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, (request) => (request === 1 ? 0.1 : 0.9))
    )

    triage.kick()
    await flush()
    appendMessage('account', 't-1', 'm-2', 200)
    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()

    timers.fire(2_000)
    await waiting
    expect(resolved).toBe(true)

    held[0]()
    await flush()
    // A stale answer is no answer to this caller: the notification decision it
    // already made was about m-2, and m-2 is still unjudged.
    expect(late).toEqual([])

    held[1]()
    await triage.settled()
    expect(late).toEqual([[{ threadId: 't-1', messageId: 'm-2' }]])
    expect(judgments('account')[0]?.evidence_key).toBe('m-2')
  })

  it('keeps a waiting conversation queued across a network failure and reports it after the retry', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let offline = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) =>
      offline ? Promise.reject(new Error('connection refused')) : answer(url, init)
    )

    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()
    expect(judgments('account')).toHaveLength(0)
    expect(resolved).toBe(false)

    // The caller cannot wait for the network to come back, so its deadline
    // releases it — but the wait itself stays with the conversation.
    timers.fire(2_000)
    await waiting
    expect(resolved).toBe(true)
    expect(late).toEqual([])

    offline = false
    timers.nowMs += SPLIT_TRIAGE_OFFLINE_RETRY_MS
    timers.fire(SPLIT_TRIAGE_OFFLINE_RETRY_MS)
    await triage.settled()

    // The offline retry judged the conversation the caller asked about, so the
    // move into the described split is still reported rather than lost.
    expect(judgments('account')[0]?.evidence_key).toBe('m-1')
    expect(late).toEqual([[{ threadId: 't-1', messageId: 'm-1' }]])
  })

  it('keeps a waiting conversation queued across a rejected request and reports it after the backoff', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let rejecting = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) =>
      rejecting ? failingTransport(400)(url, init) : answer(url, init)
    )

    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()

    // The service refused this attempt, but the budget still has attempts in
    // it, so the conversation keeps its place and the wait stays with it.
    expect(judgments('account')).toHaveLength(0)
    expect(resolved).toBe(false)
    // The caller's deadline and the conversation's own backoff, both armed.
    expect(timers.armed).toBe(2)

    timers.fire(2_000)
    await waiting
    expect(resolved).toBe(true)
    expect(late).toEqual([])
    expect(timers.armed).toBe(1)

    rejecting = false
    timers.nowMs += SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0]
    timers.fire(SPLIT_TRIAGE_FAILURE_BACKOFF_MS[0])
    await triage.settled()

    // The retry judged the arrival the caller asked about, so the move into
    // the described split is still reported.
    expect(judgments('account')[0]?.evidence_key).toBe('m-1')
    expect(late).toEqual([[{ threadId: 't-1', messageId: 'm-1' }]])

    triage.kick()
    await triage.settled()
    expect(late).toHaveLength(1)
  })

  it('releases a waiting conversation when the rejected request spends its last attempt', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let attempts = 0
    const triage = makeTriage('account', (url, init) => {
      attempts++
      return failingTransport(400)(url, init)
    })

    // Every attempt but the last is spent on ordinary passes.
    triage.kick()
    await triage.settled()
    for (const step of SPLIT_TRIAGE_FAILURE_BACKOFF_MS.slice(0, SPLIT_TRIAGE_MAX_ATTEMPTS - 2)) {
      timers.nowMs += step
      timers.fire(step)
      await triage.settled()
    }
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS - 1)

    // The wait arrives once that backoff has elapsed, so its own request is
    // the one that spends the budget.
    timers.nowMs += SPLIT_TRIAGE_FAILURE_BACKOFF_MS[SPLIT_TRIAGE_MAX_ATTEMPTS - 2]
    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()

    // Nothing asks again, so the caller is released with the budget rather
    // than held until its deadline for an answer nobody is bringing.
    expect(resolved).toBe(true)
    await waiting
    await triage.settled()
    expect(attempts).toBe(SPLIT_TRIAGE_MAX_ATTEMPTS)
    expect([...triage.failedThreadIds()]).toEqual(['t-1'])
    expect(judgments('account')).toHaveLength(0)
    expect(late).toEqual([])
    expect(timers.armed).toBe(0)
  })

  it('reports a late judgment at once while the rest of its group is still on a retry', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 200 }])
    insertThread('account', 't-2', 'Lunch plans', [{ id: 'm-2', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const packed: string[][] = []
    let offline = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) => {
      const subjects = subjectsOf(JSON.parse(String(init.body)) as RecordedRequest)
      packed.push(subjects)
      return new Promise<Response>((resolve, reject) => {
        held.push(() => {
          if (subjects.length > 1) void failingTransport(422)(url, init).then(resolve)
          else if (subjects.includes('Lunch plans') && offline) reject(new Error('connection refused'))
          else void answer(url, init).then(resolve)
        })
      })
    })

    let resolved = false
    const waiting = triage.judgeNow(['t-1', 't-2'], 2_000).then(() => {
      resolved = true
    })
    await flush()
    // Both waiting conversations ride one request. The script below answers
    // for the first one and drops the connection on the second, so the order
    // is asserted rather than assumed.
    expect(packed).toEqual([['Q3 invoice', 'Lunch plans']])

    timers.fire(2_000)
    await waiting
    expect(resolved).toBe(true)
    expect(late).toEqual([])

    // The service refuses the pack, so each conversation is asked about alone.
    held[0]()
    await flush()
    expect(packed[1]).toEqual(['Q3 invoice'])

    held[1]()
    await flush()
    // The judgment is reported the moment it lands, and it names only its own
    // conversation: the other one has not been answered for yet.
    expect(late).toEqual([[{ threadId: 't-1', messageId: 'm-1' }]])
    expect(packed[2]).toEqual(['Lunch plans'])

    // The second conversation loses its connection, so it keeps its wait.
    held[2]()
    await triage.settled()
    expect(late).toHaveLength(1)
    expect(judgments('account').map((row) => row.thread_id)).toEqual(['t-1'])

    // The group outlives the window a late notification could fire in, so the
    // pass that finds the network still down ends the wait.
    timers.nowMs += SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS + 1
    timers.fire(SPLIT_TRIAGE_OFFLINE_RETRY_MS)
    await flush()
    expect(packed[3]).toEqual(['Lunch plans'])
    held[3]()
    await triage.settled()

    offline = false
    timers.nowMs += SPLIT_TRIAGE_OFFLINE_RETRY_MS
    timers.fire(SPLIT_TRIAGE_OFFLINE_RETRY_MS)
    await flush()
    held[4]()
    await triage.settled()

    // The conversation is judged; nobody is told about it a second time.
    expect(judgments('account').map((row) => row.thread_id)).toEqual(['t-1', 't-2'])
    expect(late).toHaveLength(1)
  })

  it('reports one response of late judgments as one batch', async () => {
    const waited = ['t-1', 't-2', 't-3', 't-4']
    waited.forEach((threadId, index) => {
      insertThread('account', threadId, `Invoice ${index}`, [{ id: `m-${index}`, at: 400 - index }])
    })
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, () => 0.9)
    )

    const waiting = triage.judgeNow(waited, 2_000)
    await flush()
    // One request carries the whole group, so one answer settles all four.
    expect(held).toHaveLength(1)

    timers.fire(2_000)
    await waiting
    expect(late).toEqual([])

    held[0]()
    await triage.settled()
    // Four arrivals of one answer reach the notifier together. Reported one at
    // a time they stay singletons, and no batch ever meets the summary
    // threshold a single poll cycle of the same four arrivals would.
    expect(late).toHaveLength(1)
    expect([...(late[0] ?? [])].sort((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
      { threadId: 't-1', messageId: 'm-0' },
      { threadId: 't-2', messageId: 'm-1' },
      { threadId: 't-3', messageId: 'm-2' },
      { threadId: 't-4', messageId: 'm-3' }
    ])
  })

  it('keeps a wait open when an AI rule is added while its request is in flight', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, () => 0.9)
    )

    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()
    expect(held).toHaveLength(1)

    // The new rule asks a question this request never carried, so its answer
    // leaves the conversation pending however complete it looks.
    describedSplit('account', 'Landlord', 'Anything from my landlord')
    held[0]()
    await flush()
    expect(judgments('account').map((row) => row.split_id)).toHaveLength(1)
    expect(resolved).toBe(false)

    // The next batch re-reads the gate and asks both questions, with the wait
    // still on the conversation.
    expect(held).toHaveLength(2)
    held[1]()
    await waiting
    await triage.settled()
    expect(resolved).toBe(true)
    expect(judgments('account')).toHaveLength(2)
    expect(late).toEqual([])
  })

  it('drops a wait older than the late-notification window at the end of a pass', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let offline = true
    const answer = scriptedTransport(() => 0.9, recorded)
    const triage = makeTriage('account', (url, init) =>
      offline ? Promise.reject(new Error('connection refused')) : answer(url, init)
    )

    const waiting = triage.judgeNow(['t-1'], 2_000)
    await flush()
    timers.fire(2_000)
    await waiting

    // The network stays down past the window a late notification could fire
    // in, so the second failed pass ends the wait.
    timers.nowMs += SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS + 1
    timers.fire(SPLIT_TRIAGE_OFFLINE_RETRY_MS)
    await triage.settled()

    offline = false
    timers.nowMs += SPLIT_TRIAGE_OFFLINE_RETRY_MS
    timers.fire(SPLIT_TRIAGE_OFFLINE_RETRY_MS)
    await triage.settled()

    // The conversation is still judged; nobody is told about it.
    expect(judgments('account')).toHaveLength(1)
    expect(late).toEqual([])
  })

  it('holds a wait open when the answer no longer fits the rules in force', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    const description = 'Bills I have to pay'
    const invoices = describedSplit('account', 'Invoices', description)
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, () => 0.9)
    )

    let resolved = false
    const waiting = triage.judgeNow(['t-1'], 2_000).then(() => {
      resolved = true
    })
    await flush()
    expect(held).toHaveLength(1)

    // The user renames the split while the question it asked is in flight.
    saveSplit(db, 'account', {
      id: invoices,
      name: 'Bills',
      mode: 'description',
      description,
      notify: true
    })
    held[0]()
    await flush()

    // The answer was to a question nobody asks now, so nothing is stored and
    // the caller is still waiting for one that counts.
    expect(judgments('account')).toHaveLength(0)
    expect(resolved).toBe(false)
    expect(held).toHaveLength(2)

    held[1]()
    await waiting
    await triage.settled()
    expect(resolved).toBe(true)
    expect(judgments('account')[0]?.description_hash).toBe(judgmentHash('Bills', description))
    expect(late).toEqual([])
  })

  it('re-judges a conversation when the split is renamed', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    const description = 'Bills I have to pay'
    const invoices = describedSplit('account', 'Invoices', description)
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )

    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(1)
    expect(splitTriageCounts(db, 'account').pendingThreads).toBe(0)

    // The name is in the instructions, so the renamed split asks a question
    // the stored judgment never answered.
    saveSplit(db, 'account', {
      id: invoices,
      name: 'Bills',
      mode: 'description',
      description,
      notify: true
    })
    expect(splitTriageCounts(db, 'account').pendingThreads).toBe(1)

    triage.kick()
    await triage.settled()
    expect(recorded).toHaveLength(2)
    expect(recorded[1]?.questions.t0_s0?.instructions).toContain('"Bills"')
    expect(judgments('account')).toHaveLength(1)
    expect(judgments('account')[0]?.description_hash).toBe(judgmentHash('Bills', description))
  })

  it('drops an in-flight judgment for a split the user deleted', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    const invoices = describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, () => 0.9)
    )

    triage.kick()
    await flush()
    expect(held).toHaveLength(1)

    deleteSplit(db, 'account', invoices)
    held[0]()
    await triage.settled()

    // The question was withdrawn while it was in flight: no orphan row, and
    // no rule left to read one.
    expect(judgments('account')).toHaveLength(0)
  })

  it('drops an in-flight judgment for a conversation that is gone', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    insertThread('account', 't-2', 'Another invoice', [{ id: 'm-2', at: 90 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const held: Array<() => void> = []
    const triage = makeTriage(
      'account',
      heldTransport(held, () => 0.9)
    )

    triage.kick()
    await flush()
    expect(held).toHaveLength(1)

    // Gmail reports the conversation as gone while its judgment is in flight.
    deleteThread(db, 'account', 't-1')
    held[0]()
    await triage.settled()

    expect(judgments('account').map((row) => row.thread_id)).toEqual(['t-2'])
  })

  it('deletes the judgments of a conversation Gmail removed', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const triage = makeTriage(
      'account',
      scriptedTransport(() => 0.9, recorded)
    )

    triage.kick()
    await triage.settled()
    expect(judgments('account')).toHaveLength(1)

    deleteThread(db, 'account', 't-1')
    expect(judgments('account')).toHaveLength(0)
  })

  it('sends a waiting thread in the next pack, ahead of the backlog still queued', async () => {
    // One batch of unjudged threads plus one, all newer than the arrival, so
    // the queue order alone would put the arrival last.
    for (let index = 0; index < SPLIT_TRIAGE_BATCH_SIZE + 1; index++) {
      insertThread('account', `t-backlog-${index}`, 'Q3 invoice', [
        { id: `m-backlog-${index}`, at: 500 + index }
      ])
    }
    insertThread('account', 't-arrival', 'Dinner Friday', [{ id: 'm-arrival', at: 1 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    let triage: SplitTriage | null = null
    let waiting: Promise<void> | null = null
    let resolved = false
    const answer = scriptedTransport(() => 0.5, recorded)
    const transport: TypeSafeTransport = (url, init) => {
      // The arrival turns up once the pass is already draining the backlog.
      if (recorded.length === 1 && !waiting && triage) {
        waiting = triage.judgeNow(['t-arrival'], 2_000).then(() => {
          resolved = true
        })
      }
      return answer(url, init)
    }
    triage = makeTriage('account', transport)

    triage.kick()
    await triage.settled()
    await waiting

    // The measured pack size is a cap, not an average: no request exceeds it.
    for (const request of recorded) expect(request.state.threads.length).toBeLessThanOrEqual(10)
    const arrival = recorded.findIndex((request) => subjectsOf(request).includes('Dinner Friday'))
    const lastBacklog = recorded.reduce(
      (last, request, index) => (subjectsOf(request).includes('Q3 invoice') ? index : last),
      -1
    )
    // The arrival rode a request of its own while backlog threads were still
    // queued, rather than waiting for every one of them to be judged.
    expect(arrival).toBeGreaterThanOrEqual(0)
    expect(arrival).toBeLessThan(lastBacklog)
    expect(resolved).toBe(true)
    expect(judgments('account')).toHaveLength(SPLIT_TRIAGE_BATCH_SIZE + 2)
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

  it('clears a waiting retry when it stops', async () => {
    insertThread('account', 't-1', 'Q3 invoice', [{ id: 'm-1', at: 100 }])
    describedSplit('account', 'Invoices', 'Bills I have to pay')
    const triage = makeTriage('account', failingTransport(400))

    triage.kick()
    await triage.settled()
    expect(timers.armed).toBe(1)

    await triage.stop()
    expect(timers.armed).toBe(0)
    expect(triage.failedThreadIds().size).toBe(0)
  })
})
