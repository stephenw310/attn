import { describe, expect, it } from 'vitest'
import { buildPackedTriageRequest, buildTriageState } from '../sync/splitTriageState'
import { SPLIT_TRIAGE_REQUEST_TIMEOUT_MS } from '../sync/tuning'
import type { SchedulerTime, TimerHandle } from '../time'
import {
  judgeThread,
  TypeSafeAuthError,
  TypeSafeNetworkError,
  TypeSafeRateLimitError,
  TypeSafeRequestError,
  type TypeSafeTransport
} from './typesafeClient'

/** The manual clock the timeout rides; no test waits on the wall clock. */
class ManualTimers {
  private next = 1
  private pending = new Map<number, { callback: () => void; delayMs: number }>()

  readonly time: SchedulerTime = {
    now: () => 0,
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
}

const THREAD = buildTriageState({
  subject: 'Q3 invoice',
  messageCount: 1,
  mailingList: false,
  first: {
    fromName: 'Ada',
    fromEmail: 'ada@example.com',
    snippet: 's',
    bodyText: 'Please review',
    labels: [],
    recipientCount: 1
  },
  latest: {
    fromName: 'Ada',
    fromEmail: 'ada@example.com',
    snippet: 's',
    bodyText: 'Please review',
    labels: [],
    recipientCount: 1
  }
})

const { state: STATE, questions: QUESTIONS } = buildPackedTriageRequest(
  [THREAD],
  [{ splitId: 'custom:one', name: 'Invoices', description: 'Bills I pay', descriptionHash: 'h1' }]
)

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  } as unknown as Response
}

function call(transport: TypeSafeTransport, time: SchedulerTime): Promise<Record<string, number>> {
  return judgeThread({
    key: 'ts-secret',
    model: 'jev-latest',
    state: STATE,
    questions: QUESTIONS,
    transport,
    time
  })
}

describe('typesafe client', () => {
  it('sends the documented wire body and parses the probabilities', async () => {
    const timers = new ManualTimers()
    let seen: { url: string; init: RequestInit } | null = null
    const probabilities = await call((url, init) => {
      seen = { url, init }
      return Promise.resolve(
        response(200, { model: 'jev-latest', answers: { t0_s0: { type: 'noul', noul: 0.93 } } })
      )
    }, timers.time)
    expect(probabilities).toEqual({ t0_s0: 0.93 })
    const request = seen as unknown as { url: string; init: RequestInit }
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers).toEqual({
      Authorization: 'Bearer ts-secret',
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(String(request.init.body))).toEqual({
      state: STATE,
      model: 'jev-latest',
      questions: QUESTIONS
    })
  })

  it('reports a refused key as an auth failure', async () => {
    const timers = new ManualTimers()
    await expect(call(() => Promise.resolve(response(401, {})), timers.time)).rejects.toBeInstanceOf(
      TypeSafeAuthError
    )
  })

  it('reports rate limiting with the Retry-After it was given', async () => {
    const timers = new ManualTimers()
    const failure = await call(
      () => Promise.resolve(response(429, {}, { 'retry-after': '4' })),
      timers.time
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeSafeRateLimitError)
    expect((failure as TypeSafeRateLimitError).retryAfterMs).toBe(4_000)

    const overloaded = await call(() => Promise.resolve(response(529, {})), timers.time).catch(
      (error: unknown) => error
    )
    expect(overloaded).toBeInstanceOf(TypeSafeRateLimitError)
    expect((overloaded as TypeSafeRateLimitError).retryAfterMs).toBeNull()
  })

  it('rejects a validation failure as a request error and a malformed answer too', async () => {
    const timers = new ManualTimers()
    await expect(call(() => Promise.resolve(response(422, {})), timers.time)).rejects.toBeInstanceOf(
      TypeSafeRequestError
    )
    await expect(
      call(() => Promise.resolve(response(200, { answers: { t0_s0: { noul: 'yes' } } })), timers.time)
    ).rejects.toBeInstanceOf(TypeSafeRequestError)
    await expect(
      call(() => Promise.resolve(response(200, { answers: {} })), timers.time)
    ).rejects.toBeInstanceOf(TypeSafeRequestError)
  })

  it('aborts a hanging request at the deadline', async () => {
    const timers = new ManualTimers()
    let aborted = false
    const pending = call((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted by the transport'))
        })
      })
    }, timers.time)
    const settled = pending.catch((error: unknown) => error)
    timers.fire(SPLIT_TRIAGE_REQUEST_TIMEOUT_MS)
    const failure = await settled
    expect(aborted).toBe(true)
    expect(failure).toBeInstanceOf(TypeSafeNetworkError)
    // The transport's own message could quote the request; ours never does.
    expect((failure as Error).message).toBe('smart splits request timed out')
  })

  it('reports a body the deadline cut off as a network failure', async () => {
    const timers = new ManualTimers()
    let reading = false
    const failure = await call(
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              // The headers arrived, and the deadline fires while the body is
              // still on its way.
              reading = true
              timers.fire(SPLIT_TRIAGE_REQUEST_TIMEOUT_MS)
              reject(new Error('aborted while the body was read'))
            })
        } as unknown as Response),
      timers.time
    ).catch((error: unknown) => error)
    expect(reading).toBe(true)
    // The service refused nothing, so the pass pauses rather than charging
    // every conversation in the pack for a request it never answered.
    expect(failure).toBeInstanceOf(TypeSafeNetworkError)
    expect((failure as Error).message).toBe('smart splits request timed out')
  })

  it('reports a body that is not JSON as a request error', async () => {
    const timers = new ManualTimers()
    const failure = await call(
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.reject(new Error('unexpected token'))
        } as unknown as Response),
      timers.time
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypeSafeRequestError)
    expect((failure as Error).message).toBe('smart splits answer was not JSON')
  })

  it('treats a server failure as a network failure, not a bad request', async () => {
    const timers = new ManualTimers()
    await expect(call(() => Promise.resolve(response(503, {})), timers.time)).rejects.toBeInstanceOf(
      TypeSafeNetworkError
    )
  })
})
