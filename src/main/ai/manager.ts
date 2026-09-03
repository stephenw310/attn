// The main-process AI transport (T36, F17/D2): enable-flag gating, request
// construction, streaming, cancellation, deadlines, and late-response
// rejection — shared by explicit reply drafting (T37) and autocomplete
// (T37A). Requests go directly to the user's chosen provider; the settings
// snapshot is read fresh per request so a disable wins before any network
// object is constructed. Request payloads, generated text, and the key never
// appear in logs (F17); only the fake provider installed by the e2e seam
// records payloads, and that seam exists solely under ATTN_TEST_USER_DATA.

import {
  AI_AUTOCOMPLETE_TIMEOUT_MS,
  AI_PROVIDER_PRESETS,
  AI_REPLY_TIMEOUT_MS,
  type AiGenerateRequest,
  type AiPurpose,
  type AiStoredSettings,
  type AiStreamEvent,
  AUTOCOMPLETE_MAX_STARTS_PER_MINUTE,
  AUTOCOMPLETE_MIN_START_INTERVAL_MS,
  parseAiGenerateRequest
} from '../../shared/ai'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import type { AiKeyStore } from './keyStore'
import {
  type AiPrompt,
  AiStreamError,
  AiStreamParser,
  buildPrompt,
  buildWireRequest,
  resolveProviderTarget
} from './protocol'

/**
 * Scripted provider behavior for the e2e/unit fake (attn:test:installFakeAiProvider).
 * Chunks stream in order after `delayMs`; `error` replaces them; `hang` never
 * completes, exercising cancellation and deadlines.
 */
export interface FakeAiScript {
  chunks?: string[]
  delayMs?: number
  /** When set, chunks arrive one per interval — the mid-stream cancel probe. */
  chunkIntervalMs?: number
  error?: string
  hang?: boolean
}

/** What the fake records per request — the proof payloads used in tests. */
export interface RecordedAiRequest {
  purpose: AiPurpose
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  canceled: boolean
}

interface ActiveRequest {
  id: string
  purpose: AiPurpose
  startedAt: number
  /** Once true, no further events for this request may be emitted. */
  settled: boolean
  abort: AbortController
  deadline: TimerHandle | null
  record: RecordedAiRequest | null
}

export interface AiManagerOptions {
  keyStore: AiKeyStore
  /** Fresh stored settings per request (the utility's settings table). */
  readSettings: () => Promise<AiStoredSettings>
  emit: (event: AiStreamEvent) => void
  time?: SchedulerTime
  fetchFn?: typeof fetch
}

export class AiManager {
  private readonly time: SchedulerTime
  private readonly fetchFn: typeof fetch
  private readonly active = new Map<string, ActiveRequest>()
  private fake: { script: FakeAiScript; requests: RecordedAiRequest[] } | null = null
  private nextId = 1
  /** Start times of recent autocomplete requests (the rolling-minute cap). */
  private autocompleteStarts: number[] = []

  constructor(private readonly options: AiManagerOptions) {
    this.time = options.time ?? systemTime
    this.fetchFn = options.fetchFn ?? fetch
  }

  /**
   * Validate, gate, and start one streamed generation. Resolves with the
   * request id once the stream is running; every subsequent chunk/done/error
   * arrives through the emit callback tagged with that id.
   */
  async generate(rawRequest: unknown): Promise<{ requestId: string }> {
    const request = parseAiGenerateRequest(rawRequest)
    const settings = await this.options.readSettings()
    if (!settings.enabled) throw new Error('AI writing is disabled')
    if (request.purpose === 'autocomplete' && !settings.autocompleteEnabled) {
      throw new Error('Inline autocomplete is disabled')
    }
    const key = this.options.keyStore.load()
    if (key === null && AI_PROVIDER_PRESETS[settings.provider].keyRequired) {
      throw new Error('No AI provider key is saved')
    }
    // Bounded autocomplete work (F17): one in flight app-wide, one start per
    // second, twenty per rolling minute. A limited request is skipped — the
    // caller shows no suggestion, and nothing queues or retries.
    if (request.purpose === 'autocomplete') {
      if ([...this.active.values()].some((entry) => entry.purpose === 'autocomplete')) {
        this.logAutocomplete('skipped: another request is still in flight')
        throw new Error('An autocomplete request is already in flight')
      }
      const now = this.time.now()
      this.autocompleteStarts = this.autocompleteStarts.filter((at) => now - at < 60_000)
      const last = this.autocompleteStarts.at(-1)
      if (
        this.autocompleteStarts.length >= AUTOCOMPLETE_MAX_STARTS_PER_MINUTE ||
        (last !== undefined && now - last < AUTOCOMPLETE_MIN_START_INTERVAL_MS)
      ) {
        const reason =
          this.autocompleteStarts.length >= AUTOCOMPLETE_MAX_STARTS_PER_MINUTE
            ? 'rolling-minute limit'
            : 'minimum start interval'
        this.logAutocomplete(`skipped: ${reason}`)
        throw new Error('Autocomplete requests are rate limited')
      }
      this.autocompleteStarts.push(now)
    }
    // Voice matching off strips style examples before any request exists —
    // reply requests then provably carry none (F17 acceptance).
    const gated: AiGenerateRequest =
      request.purpose !== 'autocomplete' && !settings.voiceMatchingEnabled
        ? { ...request, styleExamples: undefined }
        : request
    const prompt = buildPrompt(gated, { tone: settings.voiceTone, rules: settings.voiceRules })
    const requestId = `ai-${this.nextId++}`
    const entry: ActiveRequest = {
      id: requestId,
      purpose: request.purpose,
      startedAt: this.time.now(),
      settled: false,
      abort: new AbortController(),
      deadline: null,
      record: null
    }
    this.active.set(requestId, entry)
    if (request.purpose === 'autocomplete') {
      const preset = AI_PROVIDER_PRESETS[settings.provider]
      this.logAutocomplete(`${requestId} started (${settings.model ?? preset.defaultModel})`)
    }
    const timeoutMs = request.purpose === 'autocomplete' ? AI_AUTOCOMPLETE_TIMEOUT_MS : AI_REPLY_TIMEOUT_MS
    entry.deadline = this.time.timers.setTimeout(() => {
      this.fail(entry, 'The AI request timed out')
    }, timeoutMs)
    if (this.fake) this.runFake(entry, prompt)
    else void this.runReal(entry, settings, key, prompt)
    return { requestId }
  }

  /** Cancel one request; late chunks from it are dropped, never emitted. */
  cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return
    const entry = this.active.get(requestId)
    if (entry) this.settle(entry, { canceled: true })
  }

  /**
   * Disable effects (F17): turning the master switch off or deleting the key
   * cancels everything in flight; turning autocomplete off cancels only its
   * work. Late responses from canceled requests are ignored.
   */
  cancelAll(purpose?: AiPurpose): void {
    for (const entry of [...this.active.values()]) {
      if (purpose === undefined || entry.purpose === purpose) this.settle(entry, { canceled: true })
    }
  }

  /** Test seam only: replace the network with a scripted provider. */
  installFakeProvider(script: FakeAiScript): void {
    this.fake = { script, requests: this.fake?.requests ?? [] }
  }

  /** Test seam only: the recorded requests (purpose + payload + canceled). */
  fakeProviderRequests(): RecordedAiRequest[] {
    return this.fake?.requests ?? []
  }

  private settle(entry: ActiveRequest, outcome: { canceled?: boolean; error?: string }): void {
    if (entry.settled) return
    entry.settled = true
    this.active.delete(entry.id)
    if (entry.deadline !== null) this.time.timers.clearTimeout(entry.deadline)
    entry.abort.abort()
    if (entry.purpose === 'autocomplete') {
      const result = outcome.error !== undefined ? outcome.error : outcome.canceled ? 'canceled' : 'completed'
      this.logAutocomplete(`${entry.id} ${result} after ${this.time.now() - entry.startedAt}ms`)
    }
    if (entry.record && outcome.canceled) entry.record.canceled = true
    if (outcome.error !== undefined) {
      this.options.emit({ requestId: entry.id, kind: 'error', message: outcome.error })
    } else if (!outcome.canceled) {
      this.options.emit({ requestId: entry.id, kind: 'done' })
    }
  }

  private fail(entry: ActiveRequest, message: string): void {
    this.settle(entry, { error: message })
  }

  /** Development diagnostics for real providers; never log prompts, text, or keys. */
  private logAutocomplete(message: string): void {
    if (this.fake === null) console.info(`[ai:autocomplete] ${message}`)
  }

  private chunk(entry: ActiveRequest, text: string): void {
    if (entry.settled || text.length === 0) return
    this.options.emit({ requestId: entry.id, kind: 'chunk', text })
  }

  private runFake(entry: ActiveRequest, prompt: AiPrompt): void {
    const fake = this.fake
    if (!fake) return
    const record: RecordedAiRequest = {
      purpose: entry.purpose,
      system: prompt.system,
      messages: prompt.messages,
      canceled: false
    }
    entry.record = record
    fake.requests.push(record)
    const script = fake.script
    const chunks = script.chunks ?? []
    const interval = script.chunkIntervalMs ?? 0
    let next = 0
    const step = (): void => {
      if (entry.settled || script.hang) return
      if (script.error !== undefined) {
        this.fail(entry, script.error)
        return
      }
      if (interval > 0) {
        if (next < chunks.length) {
          this.chunk(entry, chunks[next++])
          this.time.timers.setTimeout(step, interval)
          return
        }
        this.settle(entry, {})
        return
      }
      for (const text of chunks) this.chunk(entry, text)
      this.settle(entry, {})
    }
    this.time.timers.setTimeout(step, script.delayMs ?? 0)
  }

  private async runReal(
    entry: ActiveRequest,
    settings: AiStoredSettings,
    key: string | null,
    prompt: AiPrompt
  ): Promise<void> {
    try {
      const target = resolveProviderTarget(settings.provider, settings.baseUrl, settings.model, key)
      const wire = buildWireRequest(target, prompt)
      const response = await this.fetchFn(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: wire.body,
        signal: entry.abort.signal
      })
      if (!response.ok || !response.body) {
        // Status only — never echo a provider response body into an error
        // that could reach logs or toasts with generated/request content.
        this.fail(entry, `The AI provider returned HTTP ${response.status}`)
        return
      }
      const parser = new AiStreamParser(settings.provider)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (entry.settled) return
        if (done) break
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          this.chunk(entry, delta)
        }
      }
      this.settle(entry, {})
    } catch (error) {
      if (entry.settled) return
      // A mid-stream provider error already carries its own user-facing text,
      // and never the provider's own message.
      if (error instanceof AiStreamError) {
        this.fail(entry, error.message)
        return
      }
      const aborted = error instanceof Error && error.name === 'AbortError'
      this.fail(entry, aborted ? 'The AI request was canceled' : 'The AI provider could not be reached')
    }
  }
}
