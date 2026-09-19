// The TypeSafe System One client behind smart splits (F17 triage consent).
// One request judges a pack of threads: the pack's state travels once, and
// every (thread, described split) pair rides along as its own Noul question,
// which the service evaluates in parallel against that state.
//
// Nothing here logs a request body, a response body, or the key. Failures
// carry a fixed sentence and, where it exists, the HTTP status — enough to act
// on and to read in a log, and never enough to leak mail or a credential.

import { TYPESAFE_BASE_URL } from '../../shared/ai'
import type { NoulQuestion, PackedTriageState, TriageState } from '../sync/splitTriageState'
import { SPLIT_TRIAGE_REQUEST_TIMEOUT_MS } from '../sync/tuning'
import type { SchedulerTime, TimerHandle } from '../time'

/** Production passes `fetch`; the harness passes `fakeTriageTransport.ts`. */
export type TypeSafeTransport = (url: string, init: RequestInit) => Promise<Response>

/** The key is refused. The pass stops until a different key arrives. */
export class TypeSafeAuthError extends Error {}

/** 429 or 529. The caller waits, then asks again for the same pack. */
export class TypeSafeRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null
  ) {
    super(message)
  }
}

/** A request this pack will keep failing: skip it for the pass. */
export class TypeSafeRequestError extends Error {}

/** The service was unreachable, or the deadline passed: pause the pass. */
export class TypeSafeNetworkError extends Error {}

export interface JudgeThreadRequest {
  key: string
  model: string
  /** One thread, or a pack of them under `threads`. */
  state: TriageState | PackedTriageState
  questions: Record<string, NoulQuestion>
  transport: TypeSafeTransport
  time: SchedulerTime
  /** Cancels the request when the pass stops. */
  signal?: AbortSignal
}

interface WireAnswer {
  type?: unknown
  noul?: unknown
}

/** Seconds only, as the header's integer form; anything else falls back to the ladder. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.('retry-after')
  if (!header) return null
  const seconds = Number.parseInt(header.trim(), 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds * 1_000
}

function parseProbabilities(body: unknown, questionIds: readonly string[]): Record<string, number> {
  if (!body || typeof body !== 'object')
    throw new TypeSafeRequestError('smart splits answer was not an object')
  const answers = (body as { answers?: unknown }).answers
  if (!answers || typeof answers !== 'object') {
    throw new TypeSafeRequestError('smart splits answer carried no answers')
  }
  const probabilities: Record<string, number> = {}
  for (const id of questionIds) {
    const answer = (answers as Record<string, WireAnswer>)[id]
    const noul = answer?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new TypeSafeRequestError('smart splits answer was not a probability')
    }
    probabilities[id] = noul
  }
  return probabilities
}

/**
 * Judge one pack of threads. Resolves with the yes-probability per question
 * id, in the ids the caller asked about; a missing or malformed answer fails
 * the whole request rather than writing a judgment nobody made.
 */
export async function judgeThread(request: JudgeThreadRequest): Promise<Record<string, number>> {
  const questionIds = Object.keys(request.questions)
  if (questionIds.length === 0) return {}
  const controller = new AbortController()
  let timedOut = false
  const abortOuter = (): void => controller.abort()
  request.signal?.addEventListener('abort', abortOuter)
  const deadline: TimerHandle = request.time.timers.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, SPLIT_TRIAGE_REQUEST_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await request.transport(`${TYPESAFE_BASE_URL}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          state: request.state,
          model: request.model,
          questions: request.questions
        }),
        signal: controller.signal
      })
    } catch {
      // The reason is the transport's own error text, which may quote the
      // request. Replace it with our own sentence.
      throw new TypeSafeNetworkError(
        timedOut ? 'smart splits request timed out' : 'smart splits request could not be sent'
      )
    }
    if (!response.ok) {
      const status = response.status
      if (status === 401 || status === 403) {
        throw new TypeSafeAuthError(`smart splits key was refused (HTTP ${status})`)
      }
      if (status === 429 || status === 529) {
        throw new TypeSafeRateLimitError(
          `smart splits service is rate limiting (HTTP ${status})`,
          retryAfterMs(response)
        )
      }
      if (status >= 500) {
        throw new TypeSafeNetworkError(`smart splits service failed (HTTP ${status})`)
      }
      throw new TypeSafeRequestError(`smart splits request was rejected (HTTP ${status})`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // The deadline can abort the body read after the headers arrived. That
      // is the network failing, not the service refusing the request, so the
      // pass pauses and retries instead of charging every conversation.
      if (timedOut || controller.signal.aborted) {
        throw new TypeSafeNetworkError(
          timedOut ? 'smart splits request timed out' : 'smart splits request was canceled'
        )
      }
      throw new TypeSafeRequestError('smart splits answer was not JSON')
    }
    return parseProbabilities(body, questionIds)
  } finally {
    request.time.timers.clearTimeout(deadline)
    request.signal?.removeEventListener('abort', abortOuter)
  }
}
