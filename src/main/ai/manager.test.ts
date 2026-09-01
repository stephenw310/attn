import { describe, expect, it, vi } from 'vitest'
import {
  AI_AUTOCOMPLETE_TIMEOUT_MS,
  AI_SETTINGS_DEFAULTS,
  type AiStoredSettings,
  type AiStreamEvent
} from '../../shared/ai'
import type { SchedulerTime, TimerHandle } from '../time'
import type { AiKeyStore } from './keyStore'
import { AiManager } from './manager'

// Deterministic timers: the fake provider's delivery and the request deadline
// both ride the injected SchedulerTime, so tests fire exactly the timers they
// mean to and never wait on the wall clock.
class ManualTimers {
  private next = 1
  private pending = new Map<number, { callback: () => void; delayMs: number }>()
  nowMs = 0

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

  /** Run every pending timer with delay <= maxDelayMs, in creation order. */
  fire(maxDelayMs: number): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.delayMs <= maxDelayMs) {
        this.pending.delete(id)
        entry.callback()
      }
    }
  }
}

function keyStore(key: string | null = 'sk-test'): AiKeyStore {
  const stored = { current: key }
  return {
    present: () => stored.current !== null,
    load: () => stored.current,
    save: (value: string) => {
      stored.current = value
    },
    delete: () => {
      stored.current = null
    }
  } as unknown as AiKeyStore
}

interface Harness {
  manager: AiManager
  timers: ManualTimers
  events: AiStreamEvent[]
  fetchFn: ReturnType<typeof vi.fn>
}

function harness(
  settings: Partial<AiStoredSettings>,
  options: { key?: string | null; fetchImpl?: typeof fetch } = {}
): Harness {
  const timers = new ManualTimers()
  const events: AiStreamEvent[] = []
  const fetchFn = vi.fn(
    options.fetchImpl ??
      (() => Promise.reject(new Error('unexpected network call')) as ReturnType<typeof fetch>)
  )
  const manager = new AiManager({
    keyStore: keyStore(options.key === undefined ? 'sk-test' : options.key),
    readSettings: async () => ({ ...AI_SETTINGS_DEFAULTS, ...settings }),
    emit: (event) => events.push(event),
    time: timers.time,
    fetchFn: fetchFn as unknown as typeof fetch
  })
  return { manager, timers, events, fetchFn }
}

const replyRequest = {
  purpose: 'reply' as const,
  thread: [{ author: 'Maya', text: 'Ping?' }]
}

describe('gating', () => {
  it('disabled state short-circuits before any network object is constructed', async () => {
    const { manager, fetchFn } = harness({ enabled: false })
    await expect(manager.generate(replyRequest)).rejects.toThrow(/disabled/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('autocomplete requires its own consent even with the master switch on', async () => {
    const { manager, fetchFn } = harness({ enabled: true, autocompleteEnabled: false })
    await expect(manager.generate({ purpose: 'autocomplete', prefix: 'Hi', suffix: '' })).rejects.toThrow(
      /autocomplete/i
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('anthropic without a stored key rejects before the network', async () => {
    const { manager, fetchFn } = harness({ enabled: true }, { key: null })
    await expect(manager.generate(replyRequest)).rejects.toThrow(/key/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('a malformed request rejects at the boundary', async () => {
    const { manager, fetchFn } = harness({ enabled: true })
    await expect(manager.generate({ purpose: 'reply', thread: [] })).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('fake provider streaming', () => {
  it('streams scripted chunks as events and completes with done', async () => {
    const { manager, timers, events } = harness({ enabled: true })
    manager.installFakeProvider({ chunks: ['Hel', 'lo'] })
    const { requestId } = await manager.generate(replyRequest)
    timers.fire(0)
    expect(events).toEqual([
      { requestId, kind: 'chunk', text: 'Hel' },
      { requestId, kind: 'chunk', text: 'lo' },
      { requestId, kind: 'done' }
    ])
    expect(manager.fakeProviderRequests()).toHaveLength(1)
    expect(manager.fakeProviderRequests()[0]).toMatchObject({ purpose: 'reply', canceled: false })
  })

  it('cancel drops late chunks and records the cancellation', async () => {
    const { manager, timers, events } = harness({ enabled: true })
    manager.installFakeProvider({ chunks: ['never'], delayMs: 50 })
    const { requestId } = await manager.generate(replyRequest)
    manager.cancel(requestId)
    timers.fire(50)
    expect(events).toEqual([])
    expect(manager.fakeProviderRequests()[0].canceled).toBe(true)
  })

  it('a hung provider hits the deadline and reports a timeout error', async () => {
    const { manager, timers, events } = harness({ enabled: true })
    manager.installFakeProvider({ hang: true })
    const { requestId } = await manager.generate(replyRequest)
    timers.fire(Number.MAX_SAFE_INTEGER)
    expect(events).toEqual([{ requestId, kind: 'error', message: expect.stringMatching(/timed out/) }])
  })

  it('disabling mid-request aborts it; the autocomplete switch cancels only its own', async () => {
    const { manager, timers, events } = harness({ enabled: true, autocompleteEnabled: true })
    manager.installFakeProvider({ chunks: ['text'], delayMs: 10 })
    await manager.generate(replyRequest)
    const auto = await manager.generate({ purpose: 'autocomplete', prefix: 'Hi', suffix: '' })
    manager.cancelAll('autocomplete')
    timers.fire(10)
    // The reply stream completed; the autocomplete one emitted nothing.
    expect(events.some((event) => event.requestId === auto.requestId)).toBe(false)
    expect(events.some((event) => event.kind === 'done')).toBe(true)

    events.length = 0
    manager.installFakeProvider({ chunks: ['more'], delayMs: 10 })
    const { requestId } = await manager.generate(replyRequest)
    manager.cancelAll()
    timers.fire(10)
    expect(events.filter((event) => event.requestId === requestId)).toEqual([])
  })

  it('voice matching off strips style examples from the recorded payload', async () => {
    const { manager, timers } = harness({ enabled: true, voiceMatchingEnabled: false })
    manager.installFakeProvider({ chunks: ['ok'] })
    await manager.generate({ ...replyRequest, styleExamples: ['My style example text'] })
    timers.fire(0)
    const recorded = manager.fakeProviderRequests()[0]
    const payload = recorded.system + recorded.messages.map((message) => message.content).join('')
    expect(payload).not.toContain('My style example text')
  })

  it('voice matching on keeps the examples', async () => {
    const { manager, timers } = harness({ enabled: true, voiceMatchingEnabled: true })
    manager.installFakeProvider({ chunks: ['ok'] })
    await manager.generate({ ...replyRequest, styleExamples: ['My style example text'] })
    timers.fire(0)
    expect(manager.fakeProviderRequests()[0].system).toContain('My style example text')
  })

  it('autocomplete receives its current thread context', async () => {
    const { manager, timers } = harness({ enabled: true, autocompleteEnabled: true })
    manager.installFakeProvider({ chunks: ['ok'] })
    await manager.generate({
      purpose: 'autocomplete',
      prefix: 'Dear team',
      suffix: '',
      thread: [{ author: 'Maya', text: 'Ping?' }]
    })
    timers.fire(0)
    const recorded = manager.fakeProviderRequests()[0]
    expect(recorded.purpose).toBe('autocomplete')
    const payload = recorded.system + recorded.messages.map((message) => message.content).join('')
    expect(payload).toContain('Dear team')
    expect(payload).toContain('Ping?')
  })

  it('a paced script delivers chunk by chunk, so a mid-stream cancel keeps a true partial', async () => {
    const { manager, timers, events } = harness({ enabled: true })
    manager.installFakeProvider({ chunks: ['one', 'two', 'three'], chunkIntervalMs: 10 })
    const { requestId } = await manager.generate(replyRequest)
    timers.fire(10)
    timers.fire(10)
    expect(events).toEqual([
      { requestId, kind: 'chunk', text: 'one' },
      { requestId, kind: 'chunk', text: 'two' }
    ])
    manager.cancel(requestId)
    timers.fire(Number.MAX_SAFE_INTEGER)
    expect(events).toHaveLength(2)
    expect(manager.fakeProviderRequests()[0].canceled).toBe(true)
  })

  it('a scripted error surfaces as an error event', async () => {
    const { manager, timers, events } = harness({ enabled: true })
    manager.installFakeProvider({ error: 'provider exploded' })
    const { requestId } = await manager.generate(replyRequest)
    timers.fire(0)
    expect(events).toEqual([{ requestId, kind: 'error', message: 'provider exploded' }])
  })
})

describe('autocomplete rate limits', () => {
  const autocomplete = { purpose: 'autocomplete' as const, prefix: 'Hi', suffix: '' }
  const enabled = { enabled: true, autocompleteEnabled: true }

  it('allows only one request in flight app-wide', async () => {
    const { manager, timers } = harness(enabled)
    manager.installFakeProvider({ hang: true })
    await manager.generate(autocomplete)
    timers.nowMs = 5_000
    await expect(manager.generate(autocomplete)).rejects.toThrow(/in flight/)
  })

  it('allows the autocomplete-specific response window before timing out', async () => {
    const { manager, timers, events } = harness(enabled)
    manager.installFakeProvider({ hang: true })
    const { requestId } = await manager.generate(autocomplete)
    timers.fire(AI_AUTOCOMPLETE_TIMEOUT_MS - 1)
    expect(events).toEqual([])
    timers.fire(AI_AUTOCOMPLETE_TIMEOUT_MS)
    expect(events).toEqual([{ requestId, kind: 'error', message: expect.stringMatching(/timed out/) }])
  })

  it('spaces starts one second apart and skips rather than queues', async () => {
    const { manager, timers } = harness(enabled)
    manager.installFakeProvider({ chunks: ['ok'] })
    await manager.generate(autocomplete)
    timers.fire(0)
    timers.nowMs = 400
    await expect(manager.generate(autocomplete)).rejects.toThrow(/rate limited/)
    timers.nowMs = 1_000
    await expect(manager.generate(autocomplete)).resolves.toBeTruthy()
  })

  it('caps starts per rolling minute and recovers as the window slides', async () => {
    const { manager, timers } = harness(enabled)
    manager.installFakeProvider({ chunks: ['ok'] })
    for (let index = 0; index < 20; index++) {
      timers.nowMs = index * 2_000
      await manager.generate(autocomplete)
      timers.fire(0)
    }
    timers.nowMs = 20 * 2_000
    await expect(manager.generate(autocomplete)).rejects.toThrow(/rate limited/)
    // The oldest start leaves the rolling window; capacity returns.
    timers.nowMs = 61_000
    await expect(manager.generate(autocomplete)).resolves.toBeTruthy()
  })

  it('reply generation is never rate limited by autocomplete traffic', async () => {
    const { manager, timers } = harness(enabled)
    manager.installFakeProvider({ hang: true })
    await manager.generate(autocomplete)
    timers.nowMs = 100
    await expect(manager.generate(replyRequest)).resolves.toBeTruthy()
  })
})

describe('real transport', () => {
  function sseResponse(lines: string[]): Response {
    const encoder = new TextEncoder()
    const queue = lines.map((line) => encoder.encode(line))
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            const value = queue.shift()
            return value ? { done: false, value } : { done: true, value: undefined }
          }
        })
      }
    } as unknown as Response
  }

  it('streams and parses an Anthropic SSE response end to end', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        sseResponse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n'
        ])
      )) as unknown as typeof fetch
    const { manager, events, fetchFn } = harness({ enabled: true }, { fetchImpl })
    const { requestId } = await manager.generate(replyRequest)
    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({ requestId, kind: 'done' })
    })
    expect(events).toEqual([
      { requestId, kind: 'chunk', text: 'Hi' },
      { requestId, kind: 'chunk', text: ' there' },
      { requestId, kind: 'done' }
    ])
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('anthropic.com')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
  })

  it('a non-OK response becomes a status-only error event', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ ok: false, status: 401, body: null } as unknown as Response)) as typeof fetch
    const { manager, events } = harness({ enabled: true }, { fetchImpl })
    const { requestId } = await manager.generate(replyRequest)
    await vi.waitFor(() => {
      expect(events).toEqual([{ requestId, kind: 'error', message: 'The AI provider returned HTTP 401' }])
    })
  })

  it('cancel aborts the fetch and suppresses everything after it', async () => {
    let seenSignal: AbortSignal | null = null
    const fetchImpl = ((_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal
      return new Promise(() => {})
    }) as unknown as typeof fetch
    const { manager, events } = harness({ enabled: true }, { fetchImpl })
    const { requestId } = await manager.generate(replyRequest)
    manager.cancel(requestId)
    expect(seenSignal).not.toBeNull()
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(events).toEqual([])
  })
})
