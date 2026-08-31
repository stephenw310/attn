// The inline-autocomplete state machine (T37A, F17), free of Lexical and the
// DOM so its debounce, staleness, and dismissal rules are unit-testable with
// injected time. The plugin adapts editor events into the note* methods and
// supplies the hooks; this class owns when a request may start, which stream
// events still matter, and what a Tab may accept. Suggestion state lives only
// here — never in the persisted document — and a limited, failed, slow, or
// stale request simply yields no suggestion.

import type { AiStreamEvent } from '../../../shared/ai'
import { AUTOCOMPLETE_DEBOUNCE_MS, AUTOCOMPLETE_MAX_SUGGESTION_CHARS } from '../../../shared/ai'

export interface AutocompleteExcerpt {
  prefix: string
  suffix: string
  /** Opaque caret identity captured at dispatch, revalidated on receipt. */
  anchor: string
}

export interface AutocompleteHooks {
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
  /** Consent check at dispatch time (master + autocomplete flags). */
  isEnabled(): Promise<boolean>
  /** Null when the caret is unusable (protected region, selection, IME…). */
  buildExcerpt(): AutocompleteExcerpt | null
  /** The current caret identity, compared against the dispatched anchor. */
  currentAnchor(): string | null
  request(excerpt: AutocompleteExcerpt): Promise<{ requestId: string }>
  cancelRequest(requestId: string): void
  showPreview(text: string): void
  clearPreview(): void
}

interface PendingRequest {
  sequence: number
  requestId: string | null
  anchor: string
  buffered: string
  /** Events that raced ahead of the request-id round trip. */
  early: AiStreamEvent[]
}

/** Collapse a raw completion into one short single-line suggestion. */
export function normalizeSuggestion(raw: string): string {
  const firstLine = raw.split('\n', 1)[0] ?? ''
  return firstLine.trimEnd().slice(0, AUTOCOMPLETE_MAX_SUGGESTION_CHARS)
}

export class AutocompleteController {
  private timer: unknown = null
  private sequence = 0
  private pending: PendingRequest | null = null
  private suggestion: { text: string; anchor: string } | null = null
  private disposed = false

  constructor(private readonly hooks: AutocompleteHooks) {}

  /** A deliberate body-typing edit: reset everything and re-debounce. */
  noteTypingEdit(): void {
    if (this.disposed) return
    this.invalidate()
    this.timer = this.hooks.setTimer(() => {
      this.timer = null
      void this.dispatch()
    }, AUTOCOMPLETE_DEBOUNCE_MS)
  }

  /** Caret/selection movement without typing: clear, do not re-arm. */
  noteCaretMoved(): void {
    this.invalidate()
  }

  /**
   * Blur, pickers, dialogs, programmatic edits, undo/redo, generation, close,
   * account or settings changes: clear pending work and any preview.
   */
  noteInvalidated(): void {
    this.invalidate()
  }

  /** Esc: dismiss a visible preview. True when one was dismissed. */
  dismiss(): boolean {
    if (this.suggestion === null) return false
    this.invalidate()
    return true
  }

  /**
   * Tab: the accepted text, when a current preview exists at an unchanged
   * caret — rechecked here, at the moment of acceptance. Accepting consumes
   * the suggestion and never requests another by itself.
   */
  takeAcceptedText(): string | null {
    const current = this.suggestion
    if (current === null) return null
    if (this.hooks.currentAnchor() !== current.anchor) {
      this.invalidate()
      return null
    }
    this.suggestion = null
    this.hooks.clearPreview()
    return current.text
  }

  hasSuggestion(): boolean {
    return this.suggestion !== null
  }

  /** Route one broadcast stream event; anything not ours is ignored. */
  handleStreamEvent(event: AiStreamEvent): void {
    const pending = this.pending
    if (this.disposed || pending === null) return
    if (pending.requestId === null) {
      // The broadcast can beat the request-id round trip; hold events until
      // the id lands, when dispatch replays the ones that belong to it.
      pending.early.push(event)
      return
    }
    if (pending.requestId !== event.requestId) return
    if (event.kind === 'chunk') {
      pending.buffered += event.text
      return
    }
    this.pending = null
    if (event.kind === 'error') return
    // Completion: the suggestion shows only if the caret never moved since
    // dispatch and the text survives the single-line bound.
    const text = normalizeSuggestion(pending.buffered)
    if (text.length === 0 || this.hooks.currentAnchor() !== pending.anchor) return
    this.suggestion = { text, anchor: pending.anchor }
    this.hooks.showPreview(text)
  }

  dispose(): void {
    this.invalidate()
    this.disposed = true
  }

  /**
   * Re-arm a disposed controller. StrictMode's dev-only setup–cleanup–setup
   * cycle disposes in the probe cleanup; the second setup calls this so the
   * controller works again (PR #101 review). dispose() already invalidated
   * every timer, request, and preview, so this only clears the flag.
   */
  revive(): void {
    this.disposed = false
  }

  private invalidate(): void {
    if (this.timer !== null) {
      this.hooks.clearTimer(this.timer)
      this.timer = null
    }
    if (this.pending !== null) {
      const { requestId } = this.pending
      this.pending = null
      if (requestId !== null) this.hooks.cancelRequest(requestId)
    }
    if (this.suggestion !== null) {
      this.suggestion = null
      this.hooks.clearPreview()
    }
  }

  private async dispatch(): Promise<void> {
    if (this.disposed || this.pending !== null) return
    let enabled: boolean
    try {
      enabled = await this.hooks.isEnabled()
    } catch {
      return
    }
    if (!enabled || this.disposed) return
    const excerpt = this.hooks.buildExcerpt()
    if (excerpt === null || excerpt.prefix.trim().length === 0) return
    const pending: PendingRequest = {
      sequence: ++this.sequence,
      requestId: null,
      anchor: excerpt.anchor,
      buffered: '',
      early: []
    }
    this.pending = pending
    try {
      const { requestId } = await this.hooks.request(excerpt)
      if (this.pending !== pending) {
        // Invalidated while the id was in flight: the request must die too.
        this.hooks.cancelRequest(requestId)
        return
      }
      pending.requestId = requestId
      for (const event of pending.early.splice(0)) {
        if (event.requestId === requestId) this.handleStreamEvent(event)
      }
    } catch {
      // Rate limited, disabled, offline: no suggestion, no retry, no toast.
      if (this.pending === pending) this.pending = null
    }
  }
}
