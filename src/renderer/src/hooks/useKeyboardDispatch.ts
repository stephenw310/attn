import { useLayoutEffect, useRef } from 'react'
import { chordKey, findCommandByShortcut, isChordPrefix, matchKey, readingScrollDelta } from '../commands'

interface KeyboardDispatchOptions {
  blocked: boolean
  readerOpen: boolean
  outboxOpen: boolean
  snoozeOpen: boolean
  onCloseSnooze: () => void
  conversationScrollRef: React.RefObject<HTMLDivElement | null>
}

export function useKeyboardDispatch(options: KeyboardDispatchOptions): void {
  const { blocked, readerOpen, outboxOpen, snoozeOpen, onCloseSnooze, conversationScrollRef } = options
  const pendingChordRef = useRef<{ key: string; until: number } | null>(null)

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const key = chordKey(event)
      const pendingChord = pendingChordRef.current
      pendingChordRef.current = null
      if (blocked) return
      if (snoozeOpen) {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCloseSnooze()
        }
        return
      }
      const target = event.target instanceof Element ? event.target : null
      const context = readerOpen ? 'reader' : outboxOpen ? 'outbox' : 'list'
      const modifiedCommand = event.metaKey || event.ctrlKey ? matchKey(event, context) : null
      if (modifiedCommand?.context === 'global') {
        event.preventDefault()
        modifiedCommand.run()
        return
      }
      const isTextEntry =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (isTextEntry) return
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
      if (key !== null && pendingChord && Date.now() <= pendingChord.until) {
        const command = findCommandByShortcut(`${pendingChord.key} ${key}`, context)
        if (!command) return
        event.preventDefault()
        command.run()
        return
      }
      if (key !== null && isChordPrefix(key, context)) {
        event.preventDefault()
        pendingChordRef.current = { key, until: Date.now() + 500 }
        return
      }
      const command = matchKey(event, context)
      if (!command) return
      event.preventDefault()
      command.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [blocked, conversationScrollRef, onCloseSnooze, outboxOpen, readerOpen, snoozeOpen])
}
