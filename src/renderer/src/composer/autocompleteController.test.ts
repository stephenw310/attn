import { describe, expect, it } from 'vitest'
import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  AUTOCOMPLETE_MAX_SUGGESTION_CHARS,
  AUTOCOMPLETE_MIN_START_INTERVAL_MS
} from '../../../shared/ai'
import {
  AutocompleteController,
  type AutocompleteExcerpt,
  type AutocompleteHooks,
  normalizeSuggestion
} from './autocompleteController'

// Deterministic timers for the debounce; requests resolve through microtasks,
// so tests await a tick after firing.
class Timers {
  private next = 1
  private pending = new Map<number, { callback: () => void; delayMs: number }>()

  set = (callback: () => void, delayMs: number): unknown => {
    const id = this.next++
    this.pending.set(id, { callback, delayMs })
    return id
  }

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }

  fire(maxDelayMs: number): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.delayMs <= maxDelayMs) {
        this.pending.delete(id)
        entry.callback()
      }
    }
  }

  count(): number {
    return this.pending.size
  }
}

interface Harness {
  controller: AutocompleteController
  timers: Timers
  hooks: {
    enabled: boolean
    excerpt: AutocompleteExcerpt | null
    anchor: string | null
    requests: AutocompleteExcerpt[]
    canceled: string[]
    previews: Array<string | null>
    failRequests: boolean
    nowMs: number
  }
}

function harness(): Harness {
  const timers = new Timers()
  const state: Harness['hooks'] = {
    enabled: true,
    excerpt: { prefix: 'Hello wor', suffix: '', anchor: 'a-1' },
    anchor: 'a-1',
    requests: [],
    canceled: [],
    previews: [],
    failRequests: false,
    nowMs: 0
  }
  let nextId = 1
  const hooks: AutocompleteHooks = {
    now: () => state.nowMs,
    setTimer: timers.set,
    clearTimer: timers.clear,
    isEnabled: async () => state.enabled,
    buildExcerpt: () => state.excerpt,
    currentAnchor: () => state.anchor,
    request: async (excerpt) => {
      state.requests.push(excerpt)
      if (state.failRequests) throw new Error('rate limited')
      return { requestId: `ac-${nextId++}` }
    },
    cancelRequest: (requestId) => {
      state.canceled.push(requestId)
    },
    showPreview: (text) => {
      state.previews.push(text)
    },
    clearPreview: () => {
      state.previews.push(null)
    }
  }
  return { controller: new AutocompleteController(hooks), timers, hooks: state }
}

async function settle(): Promise<void> {
  // Flush the dispatch's microtask chain (consent check, request round trip).
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function completedSuggestion(h: Harness, text: string): Promise<void> {
  h.controller.noteTypingEdit()
  h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
  await settle()
  const requestId = `ac-${h.hooks.requests.length}`
  h.controller.handleStreamEvent({ requestId, kind: 'chunk', text })
  h.controller.handleStreamEvent({ requestId, kind: 'done' })
}

describe('debounce', () => {
  it('waits the full pause and restarts on further typing', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS - 1)
    await settle()
    expect(h.hooks.requests).toHaveLength(0)
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(1)
    expect(h.timers.count()).toBe(0)
  })

  it('never requests while disabled or with an unusable caret', async () => {
    const h = harness()
    h.hooks.enabled = false
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.hooks.enabled = true
    h.hooks.excerpt = null
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    // An empty authored prefix is also never sent.
    h.hooks.excerpt = { prefix: '   ', suffix: 'x', anchor: 'a-1' }
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(0)
  })

  it('coalesces a replacement until the one-second start interval expires', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(1)

    h.hooks.nowMs = 600
    h.controller.noteTypingEdit()
    expect(h.hooks.canceled).toEqual(['ac-1'])
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(1)
    expect(h.timers.count()).toBe(1)

    h.hooks.nowMs = AUTOCOMPLETE_MIN_START_INTERVAL_MS
    h.timers.fire(AUTOCOMPLETE_MIN_START_INTERVAL_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(2)
    expect(h.timers.count()).toBe(0)
  })
})

describe('suggestion lifecycle', () => {
  it('shows and accepts a local suggestion immediately without a provider request', () => {
    const h = harness()
    h.controller.noteTypingEdit({ text: ' Theo,', anchor: 'a-1' })
    expect(h.hooks.previews).toEqual([' Theo,'])
    expect(h.hooks.requests).toHaveLength(0)
    expect(h.timers.count()).toBe(0)
    expect(h.controller.takeAcceptedText()).toBe(' Theo,')
  })

  it('buffers chunks and shows the completed single-line suggestion', async () => {
    const h = harness()
    await completedSuggestion(h, 'ld, how are you?')
    expect(h.hooks.previews).toEqual(['ld, how are you?', 'ld, how are you?'])
    expect(h.controller.takeAcceptedText()).toBe('ld, how are you?')
  })

  it('updates the gray preview as chunks arrive instead of waiting for completion', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'chunk', text: 'ld, how' })
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'chunk', text: ' are you?' })
    expect(h.hooks.previews).toEqual(['ld, how', 'ld, how are you?'])
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'done' })
    expect(h.hooks.previews).toEqual(['ld, how', 'ld, how are you?', 'ld, how are you?'])
  })

  it('normalizes to one line and the character cap', () => {
    expect(normalizeSuggestion('first line\nsecond line')).toBe('first line')
    expect(normalizeSuggestion('x'.repeat(500))).toHaveLength(AUTOCOMPLETE_MAX_SUGGESTION_CHARS)
    expect(normalizeSuggestion('\nleading newline')).toBe('')
  })

  it('strips a current-line echo and suppresses a restarted greeting', () => {
    expect(normalizeSuggestion('We are hiring next week.', 'Hi Amit,\n\nWe are')).toBe(' hiring next week.')
    expect(normalizeSuggestion('Hi', 'Hi Amit,\n\nWe are')).toBe('')
    expect(normalizeSuggestion('Hi Amit,', 'Hi Amit,\n\nWe are')).toBe('')
  })

  it('never previews a streamed greeting restart after a completed greeting', async () => {
    const h = harness()
    h.hooks.excerpt = { prefix: 'Hi Amit,\n\nWe are', suffix: '', anchor: 'a-1' }
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'chunk', text: 'Hi' })
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'chunk', text: ' Amit,' })
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'done' })
    expect(h.hooks.previews).toEqual([])
    expect(h.controller.dismiss()).toBe(false)
  })

  it('acceptance returns the text once and clears the preview', async () => {
    const h = harness()
    await completedSuggestion(h, 'ld!')
    expect(h.controller.takeAcceptedText()).toBe('ld!')
    expect(h.controller.takeAcceptedText()).toBeNull()
    expect(h.hooks.previews.at(-1)).toBeNull()
  })

  it('acceptance rechecks the caret and refuses after it moved', async () => {
    const h = harness()
    await completedSuggestion(h, 'ld!')
    h.hooks.anchor = 'a-2'
    expect(h.controller.takeAcceptedText()).toBeNull()
    // Refused *and* dropped: nothing is left for a later Tab to accept.
    expect(h.controller.dismiss()).toBe(false)
  })

  it('a dismissed suggestion cannot reappear without fresh typing', async () => {
    const h = harness()
    await completedSuggestion(h, 'ld!')
    expect(h.controller.dismiss()).toBe(true)
    expect(h.controller.dismiss()).toBe(false)
    expect(h.timers.count()).toBe(0)
  })
})

describe('staleness and cancellation', () => {
  it('a result for a moved caret never shows', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.hooks.anchor = 'a-2'
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'chunk', text: 'stale' })
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'done' })
    expect(h.hooks.previews).toEqual([])
  })

  it('caret movement cancels in-flight work without re-arming', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.noteCaretMoved()
    expect(h.hooks.canceled).toEqual(['ac-1'])
    expect(h.timers.count()).toBe(0)
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'done' })
    expect(h.hooks.previews).toEqual([])
  })

  it('an error result yields nothing and never retries', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.handleStreamEvent({ requestId: 'ac-1', kind: 'error', message: 'timeout' })
    expect(h.hooks.previews).toEqual([])
    expect(h.timers.count()).toBe(0)
  })

  it('a rejected request (rate limit) is silent with no queue', async () => {
    const h = harness()
    h.hooks.failRequests = true
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(1)
    expect(h.hooks.previews).toEqual([])
    expect(h.timers.count()).toBe(0)
  })

  it('events racing the request id are replayed only for the right id', async () => {
    const h = harness()
    const gate: { release: ((value: { requestId: string }) => void) | null } = { release: null }
    const original = h.controller as unknown as { hooks: AutocompleteHooks }
    original.hooks.request = () =>
      new Promise((resolve) => {
        gate.release = resolve
      })
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.handleStreamEvent({ requestId: 'ac-9', kind: 'chunk', text: 'early ' })
    h.controller.handleStreamEvent({ requestId: 'other', kind: 'chunk', text: 'noise' })
    h.controller.handleStreamEvent({ requestId: 'ac-9', kind: 'done' })
    gate.release?.({ requestId: 'ac-9' })
    await settle()
    expect(h.hooks.previews).toEqual(['early', 'early'])
  })

  it('dispose cancels everything and refuses further work', async () => {
    const h = harness()
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    h.controller.dispose()
    expect(h.hooks.canceled).toEqual(['ac-1'])
    h.controller.noteTypingEdit()
    h.timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
    await settle()
    expect(h.hooks.requests).toHaveLength(1)
  })
})

it('revive re-arms a disposed controller — StrictMode probe cleanup must not kill it', async () => {
  const { controller, timers, hooks } = harness()
  controller.dispose()
  controller.noteTypingEdit()
  timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
  await settle()
  expect(hooks.requests).toHaveLength(0)

  controller.revive()
  controller.noteTypingEdit()
  timers.fire(AUTOCOMPLETE_DEBOUNCE_MS)
  await settle()
  expect(hooks.requests).toHaveLength(1)
})
