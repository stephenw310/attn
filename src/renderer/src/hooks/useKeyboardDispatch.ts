import { useCallback, useLayoutEffect, useRef } from 'react'
import { chordKey, findCommandByShortcut, isChordPrefix, matchKey, readingScrollDelta } from '../commands'

export const CHORD_TIMEOUT_MS = 3_000

interface KeyboardDispatchOptions {
  blocked: boolean
  readerOpen: boolean
  outboxOpen: boolean
  snoozeOpen: boolean
  onCloseSnooze: () => void
  viewKey: string
  onPendingChordChange: (key: string | null) => void
  conversationScrollRef: React.RefObject<HTMLDivElement | null>
}

export function useKeyboardDispatch(options: KeyboardDispatchOptions): void {
  const {
    blocked,
    readerOpen,
    outboxOpen,
    snoozeOpen,
    onCloseSnooze,
    viewKey,
    onPendingChordChange,
    conversationScrollRef
  } = options
  const pendingChordRef = useRef<{ key: string; until: number } | null>(null)
  const chordTimerRef = useRef<number | null>(null)
  const chordScopeRef = useRef({ blocked, viewKey })
  const onPendingChordChangeRef = useRef(onPendingChordChange)
  onPendingChordChangeRef.current = onPendingChordChange

  const clearPendingChord = useCallback(() => {
    if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current)
    chordTimerRef.current = null
    if (!pendingChordRef.current) return
    pendingChordRef.current = null
    onPendingChordChangeRef.current(null)
  }, [])

  const armPendingChord = useCallback((key: string) => {
    if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current)
    const until = Date.now() + CHORD_TIMEOUT_MS
    pendingChordRef.current = { key, until }
    onPendingChordChangeRef.current(key)
    chordTimerRef.current = window.setTimeout(() => {
      if (pendingChordRef.current?.until !== until) return
      pendingChordRef.current = null
      chordTimerRef.current = null
      onPendingChordChangeRef.current(null)
    }, CHORD_TIMEOUT_MS)
  }, [])

  useLayoutEffect(() => {
    const previous = chordScopeRef.current
    chordScopeRef.current = { blocked, viewKey }
    if (previous.blocked !== blocked || previous.viewKey !== viewKey) clearPendingChord()
  }, [blocked, clearPendingChord, viewKey])

  useLayoutEffect(
    () => () => {
      if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current)
    },
    []
  )

  useLayoutEffect(() => {
    const cancelOnKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        clearPendingChord()
      }
    }
    const cancelOnPointerDown = (): void => clearPendingChord()
    // Overlays consume Escape during capture, before the bubble dispatcher can
    // observe it. Cancel at the window boundary so every overlay shares the
    // same chord state without knowing about the keyboard dispatcher.
    window.addEventListener('keydown', cancelOnKeyDown, true)
    window.addEventListener('pointerdown', cancelOnPointerDown, true)
    return () => {
      window.removeEventListener('keydown', cancelOnKeyDown, true)
      window.removeEventListener('pointerdown', cancelOnPointerDown, true)
    }
  }, [clearPendingChord])

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const key = chordKey(event)
      const pendingChord = pendingChordRef.current
      if (blocked) {
        clearPendingChord()
        return
      }
      if (snoozeOpen) {
        clearPendingChord()
        if (event.key === 'Escape') {
          event.preventDefault()
          onCloseSnooze()
        }
        return
      }
      const target = event.target instanceof Element ? event.target : null
      const context = readerOpen ? 'reader' : outboxOpen ? 'outbox' : 'list'
      // Reader Escape is the dependable route back to the list. Resolve it
      // before chord and text-entry guards so stale focus or an armed G guide
      // cannot turn the key into a no-op. Transient overlays return above and
      // keep first refusal over Escape.
      if (readerOpen && event.key === 'Escape') {
        clearPendingChord()
        const closeReader = matchKey(event, context)
        if (closeReader) {
          event.preventDefault()
          closeReader.run()
        }
        return
      }
      const modifiedCommand = event.metaKey || event.ctrlKey ? matchKey(event, context) : null
      if (modifiedCommand) {
        clearPendingChord()
        event.preventDefault()
        modifiedCommand.run()
        return
      }
      const isTextEntry =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (isTextEntry) {
        clearPendingChord()
        return
      }
      const tabCommand = event.key === 'Tab' ? matchKey(event, context) : null
      const keepsNativeTab = target?.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-testid="account-menu"]'
      )
      if (tabCommand && !keepsNativeTab) {
        clearPendingChord()
        event.preventDefault()
        tabCommand.run()
        return
      }
      if (pendingChord) {
        if (event.repeat && event.key.toLowerCase() === pendingChord.key) {
          event.preventDefault()
          return
        }
        if (key !== null && Date.now() <= pendingChord.until) {
          const command = findCommandByShortcut(`${pendingChord.key} ${key}`, context)
          if (command) {
            event.preventDefault()
            clearPendingChord()
            command.run()
            return
          }
          if (isChordPrefix(key, context)) {
            event.preventDefault()
            armPendingChord(key)
            return
          }
        }
        clearPendingChord()
        return
      }
      if (key !== null && isChordPrefix(key, context)) {
        event.preventDefault()
        armPendingChord(key)
        return
      }
      const isInteractive = target?.closest('a, button, input, textarea, select, [contenteditable="true"]')
      if (isInteractive && event.key !== 'Escape') return
      const scroll = conversationScrollRef.current
      if (readerOpen && scroll) {
        const scrollDelta = readingScrollDelta(event, scroll.clientHeight)
        if (scrollDelta !== null) {
          event.preventDefault()
          scroll.scrollBy({ top: scrollDelta })
          return
        }
      }
      const command = matchKey(event, context)
      if (!command) return
      event.preventDefault()
      command.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    armPendingChord,
    blocked,
    clearPendingChord,
    conversationScrollRef,
    onCloseSnooze,
    outboxOpen,
    readerOpen,
    snoozeOpen
  ])
}
