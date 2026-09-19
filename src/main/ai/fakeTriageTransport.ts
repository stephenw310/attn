// The scripted TypeSafe service behind `attn:test:installFakeTriageProvider`.
// It replaces the network at the transport seam, so the shipped client builds
// the wire body, classifies the status, and parses the answers exactly as it
// does in production (REF-6).
//
// What it records is the body that actually left the process, parsed back.
// That is what makes the smart-splits privacy assertions — no recipient
// addresses, no HTML, a bounded excerpt — proof rather than a restatement of
// the state builder's intent.

import { type SchedulerTime, systemTime } from '../time'
import type { TypeSafeTransport } from './typesafeClient'

/**
 * Scripted answers. `bySubject` matches one conversation's subject; within a
 * match, `probabilities` is keyed by split name (the question instructions
 * quote it) with `'*'` as that entry's catch-all. One request carries a pack of
 * conversations, so each question is answered against the conversation its id
 * names. `status` and `hang` drive the failure paths; `delayMs` rides the
 * injected clock in unit runs.
 */
export interface FakeTriageScript {
  default?: number
  bySubject?: Array<{ subjectIncludes: string; probabilities: Record<string, number> }>
  delayMs?: number
  status?: number
  hang?: boolean
}

export interface RecordedTriageRequest {
  state: unknown
  questions: Record<string, { instructions?: string; criteria?: unknown }>
}

interface ParsedBody {
  state: unknown
  questions: Record<string, { instructions?: string; criteria?: unknown }>
}

function parseBody(body: unknown): ParsedBody {
  try {
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as ParsedBody) : { state: null, questions: {} }
    return { state: parsed.state ?? null, questions: parsed.questions ?? {} }
  } catch {
    return { state: null, questions: {} }
  }
}

function subjectOf(state: unknown): string {
  if (!state || typeof state !== 'object') return ''
  const subject = (state as { subject?: unknown }).subject
  return typeof subject === 'string' ? subject : ''
}

/** `t3_s1` asks about `state.threads[3]`. An unpacked state answers for itself. */
const PACKED_QUESTION_ID = /^t(\d+)_s\d+$/

function threadStateFor(state: unknown, questionId: string): unknown {
  const match = PACKED_QUESTION_ID.exec(questionId)
  if (!match || !state || typeof state !== 'object') return state
  const threads = (state as { threads?: unknown }).threads
  return Array.isArray(threads) ? threads[Number(match[1])] : state
}

export class FakeTriageTransport {
  private script: FakeTriageScript = {}
  private readonly requests: RecordedTriageRequest[] = []

  constructor(private readonly time: SchedulerTime = systemTime) {}

  install(script: FakeTriageScript): void {
    this.script = script
  }

  recorded(): RecordedTriageRequest[] {
    return this.requests
  }

  /** The probability this script answers for one question of one thread. */
  private probabilityFor(threadState: unknown, instructions: string): number {
    const fallback = this.script.default ?? 0
    const subject = subjectOf(threadState)
    const entry = this.script.bySubject?.find((row) => subject.includes(row.subjectIncludes))
    if (!entry) return fallback
    // The split's name is what the question quotes, so a scripted answer names
    // the split the user sees rather than an id the harness cannot know.
    for (const [name, probability] of Object.entries(entry.probabilities)) {
      if (name !== '*' && instructions.includes(`"${name}"`)) return probability
    }
    return entry.probabilities['*'] ?? fallback
  }

  readonly fetch: TypeSafeTransport = (_url, init) => {
    const parsed = parseBody(init.body)
    this.requests.push({ state: parsed.state, questions: parsed.questions })
    const script = this.script
    return new Promise<Response>((resolve) => {
      this.time.timers.setTimeout(() => {
        if (script.hang) return
        if (script.status !== undefined && script.status !== 200) {
          resolve({
            ok: false,
            status: script.status,
            headers: { get: () => null },
            json: async () => ({})
          } as unknown as Response)
          return
        }
        const answers: Record<string, { type: string; noul: number }> = {}
        for (const [id, question] of Object.entries(parsed.questions)) {
          answers[id] = {
            type: 'noul',
            noul: this.probabilityFor(threadStateFor(parsed.state, id), question.instructions ?? '')
          }
        }
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: 'jev-latest',
            answers,
            usage: { input_tokens: 0, output_tokens: 0 }
          })
        } as unknown as Response)
      }, script.delayMs ?? 0)
    })
  }
}
