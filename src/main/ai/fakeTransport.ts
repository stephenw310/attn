// The scripted AI provider behind `attn:test:installFakeAiProvider` (T36).
// It replaces the network at `AiManagerOptions.fetchFn`, so `AiManager` keeps
// exactly one generation path and the harness drives the shipped one: wire
// building, SSE parsing, cancellation and deadlines all execute (REF-6).
//
// What it records is what actually left main — the provider's own request body,
// parsed back — which is what makes the F17 privacy assertions (no style
// examples when voice matching is off, no mail text when AI is disabled) proof
// rather than a restatement of the manager's intent.

import type { AiPurpose } from '../../shared/ai'
import { type SchedulerTime, systemTime } from '../time'
import type { AiTransport } from './manager'
import { AiStreamError } from './protocol'

/**
 * Scripted provider behavior. Chunks stream in order after `delayMs`;
 * `chunkIntervalMs` paces them one per interval (the mid-stream cancel probe);
 * `error` replaces them; `hang` never answers, exercising the deadline.
 */
export interface FakeAiScript {
  chunks?: string[]
  delayMs?: number
  chunkIntervalMs?: number
  error?: string
  hang?: boolean
  /** Close the stream with this Anthropic stop reason after the chunks (`max_tokens` = truncated). */
  stopReason?: string
}

/** What the fake records per request — the proof payloads used in tests. */
export interface RecordedAiRequest {
  purpose: AiPurpose
  system: string
  messages: Array<{ role: string; content: string }>
  canceled: boolean
}

interface WirePayload {
  system: string
  messages: Array<{ role: string; content: string }>
}

/**
 * Read the prompt back out of the request body both wire protocols produce:
 * Anthropic carries `system` beside the turns, OpenAI-compatible carries it as
 * the first message.
 */
function parseWireBody(body: unknown): WirePayload {
  let parsed: { system?: unknown; messages?: unknown } = {}
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : {}
  } catch {
    return { system: '', messages: [] }
  }
  const messages = Array.isArray(parsed.messages)
    ? (parsed.messages as Array<{ role?: unknown; content?: unknown }>).map((message) => ({
        role: String(message.role ?? ''),
        content: String(message.content ?? '')
      }))
    : []
  if (typeof parsed.system === 'string') return { system: parsed.system, messages }
  const leading = messages[0]
  if (leading?.role === 'system') return { system: leading.content, messages: messages.slice(1) }
  return { system: '', messages }
}

function sseFrame(text: string): string {
  // The Anthropic frame; `AiStreamParser` accepts either protocol's `data:`
  // lines, and both e2e and unit runs use whichever the settings select.
  return `data: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text }
  })}\n`
}

function stopFrame(stopReason: string): string {
  return `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 }
  })}\n`
}

export class FakeAiTransport {
  private script: FakeAiScript = {}
  private readonly requests: RecordedAiRequest[] = []

  constructor(private readonly time: SchedulerTime = systemTime) {}

  /** Arm the next requests. Recorded history survives, as the old seam's did. */
  install(script: FakeAiScript): void {
    this.script = script
  }

  recorded(): RecordedAiRequest[] {
    return this.requests
  }

  readonly fetch: AiTransport = (_url, init, purpose) => {
    const script = this.script
    const record: RecordedAiRequest = { purpose, ...parseWireBody(init.body), canceled: false }
    this.requests.push(record)
    // A stream the manager cut short is a cancellation; one that ran to its
    // end (or to a scripted error) is not, whatever the manager does after.
    let finished = false
    init.signal?.addEventListener('abort', () => {
      if (!finished) record.canceled = true
    })
    return new Promise<Response>((resolve, reject) => {
      this.time.timers.setTimeout(() => {
        if (script.hang) return
        if (script.error !== undefined) {
          finished = true
          // The manager passes an `AiStreamError`'s own message through
          // untouched — the one provider-supplied text it trusts — which is
          // how a scripted failure reaches the renderer verbatim.
          const failure = new AiStreamError()
          failure.message = script.error
          reject(failure)
          return
        }
        const encoder = new TextEncoder()
        const frames = [
          ...(script.chunks ?? []).map((text) => sseFrame(text)),
          ...(script.stopReason !== undefined ? [stopFrame(script.stopReason)] : [])
        ].map((frame) => encoder.encode(frame))
        const interval = script.chunkIntervalMs ?? 0
        let next = 0
        const read = (): Promise<{ done: boolean; value?: Uint8Array }> => {
          const frame = frames[next]
          next++
          const deliver = (): { done: boolean; value?: Uint8Array } => {
            if (frame !== undefined) {
              // A stop frame is the provider's own end of stream: if the parser
              // rejects it, the manager's abort is not a cancellation.
              if (script.stopReason !== undefined && next === frames.length) finished = true
              return { done: false, value: frame }
            }
            finished = true
            return { done: true, value: undefined }
          }
          // The first frame lands as soon as the response does; every later
          // step waits out the interval, the completion included — so a cancel
          // during the final gap still finds the request in flight.
          if (interval <= 0 || next <= 1) return Promise.resolve(deliver())
          return new Promise((resolve) => {
            this.time.timers.setTimeout(() => resolve(deliver()), interval)
          })
        }
        resolve({ ok: true, status: 200, body: { getReader: () => ({ read }) } } as unknown as Response)
      }, script.delayMs ?? 0)
    })
  }
}
