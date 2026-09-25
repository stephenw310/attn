import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MAIL_TRIM_MARKER } from '../../../shared/mailSanitizer'
import { createCommand, registerCommands } from '../commands'
import { FIND_HIGHLIGHT_CSS, findTextRanges } from '../readerFind'

interface Props {
  scrollRef: React.RefObject<HTMLDivElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onReveal: (messageId: string, revealTrim: boolean) => void
  incomplete: boolean
}
interface Match {
  range: Range
  messageId: string
  frame: HTMLIFrameElement | null
}

export function ReaderFind({
  scrollRef,
  open,
  onOpenChange,
  onReveal,
  incomplete
}: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const show = useCallback(() => {
    onOpenChange(true)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [onOpenChange])
  const close = useCallback(() => {
    onOpenChange(false)
    setMatches([])
    setIndex(0)
    scrollRef.current?.focus({ preventScroll: true })
  }, [onOpenChange, scrollRef])
  const move = useCallback(
    (offset: number) => {
      setIndex((current) => (matches.length ? (current + offset + matches.length) % matches.length : 0))
    },
    [matches.length]
  )

  useLayoutEffect(() => registerCommands([createCommand('conversation.find', show)]), [show])
  useLayoutEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('[data-testid="conversation-view"]')) return
      if (target.closest('[role="dialog"], [role="menu"], .app-inline-composer')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
      } else if (event.key === 'Enter' && target?.closest('[data-testid="reader-find"]')) {
        // Buttons retain their native Enter activation.
        if (target.closest('button')) return
        event.preventDefault()
        event.stopImmediatePropagation()
        move(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [close, move, open])

  useLayoutEffect(() => {
    if (!open) return
    const root = scrollRef.current
    if (!root) return
    let scheduled = 0
    const styles = new Map<Document, HTMLStyleElement>()
    const scan = (): void => {
      scheduled = 0
      const next: Match[] = []
      for (const message of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
        for (const body of message.querySelectorAll<HTMLElement>('[data-find-body], iframe')) {
          const frame = body instanceof HTMLIFrameElement ? body : null
          const content = frame ? frame.contentDocument?.body : body
          if (!content) continue
          const doc = content.ownerDocument
          if (!styles.has(doc)) {
            const style = doc.createElement('style')
            style.textContent = FIND_HIGHLIGHT_CSS
            doc.head.append(style)
            styles.set(doc, style)
          }
          for (const range of findTextRanges(content, query)) {
            next.push({ range, messageId: message.dataset.messageId ?? '', frame })
          }
        }
      }
      setMatches(next)
      setIndex((current) => Math.min(current, Math.max(0, next.length - 1)))
    }
    const schedule = (): void => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(scan)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    root.addEventListener('load', schedule, true)
    scan()
    return () => {
      observer.disconnect()
      root.removeEventListener('load', schedule, true)
      cancelAnimationFrame(scheduled)
      for (const [doc, style] of styles) {
        const view = doc.defaultView as (Window & typeof globalThis) | null
        view?.CSS.highlights.delete('attn-find')
        view?.CSS.highlights.delete('attn-find-active')
        style.remove()
      }
    }
  }, [open, query, scrollRef])

  useLayoutEffect(() => {
    if (!open) return
    const grouped = new Map<Document, Range[]>()
    for (const match of matches) {
      const doc = match.range.startContainer.ownerDocument ?? document
      const ranges = grouped.get(doc) ?? []
      ranges.push(match.range)
      grouped.set(doc, ranges)
    }
    for (const [doc, ranges] of grouped) {
      const view = doc.defaultView as (Window & typeof globalThis) | null
      if (!view) continue
      const highlight = new view.Highlight()
      for (const range of ranges) highlight.add(range)
      view.CSS.highlights.set('attn-find', highlight)
      view.CSS.highlights.delete('attn-find-active')
    }
    const active = matches[index]
    if (!active) return
    const view = active.range.startContainer.ownerDocument?.defaultView as (Window & typeof globalThis) | null
    if (!view) return
    view.CSS.highlights.set('attn-find-active', new view.Highlight(active.range))
    const element = active.range.startContainer.parentElement
    const marker = active.frame?.contentDocument?.querySelector(`[${MAIL_TRIM_MARKER}]`)
    const inTrim = Boolean(
      element?.closest('[data-testid="plain-text-trimmed"]') ||
        active.frame?.closest('[data-testid="mail-quoted-section"]') ||
        (marker &&
          marker.compareDocumentPosition(active.range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
    onReveal(active.messageId, inTrim)
    const scroll = scrollRef.current
    if (!scroll) return
    let scheduled = 0
    const align = (): void => {
      cancelAnimationFrame(scheduled)
      scheduled = requestAnimationFrame(() => {
        const rect = active.range.getBoundingClientRect()
        if (!rect.height) return
        if (active.frame) {
          const frameDoc = active.frame.contentDocument
          const width = active.frame.clientWidth
          if (frameDoc?.scrollingElement && (rect.left < 0 || rect.right > width)) {
            frameDoc.scrollingElement.scrollLeft += rect.left - width / 2
          }
        }
        const frameTop = active.frame?.getBoundingClientRect().top ?? 0
        const top = rect.top + frameTop
        const viewport = scroll.getBoundingClientRect()
        if (top < viewport.top + 24 || top + rect.height > viewport.bottom - 24) {
          scroll.scrollTop += top - viewport.top - scroll.clientHeight / 2
        }
      })
    }
    const observer = new ResizeObserver(align)
    observer.observe(scroll)
    const message = [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (element) => element.dataset.messageId === active.messageId
    )
    if (message) observer.observe(message)
    align()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(scheduled)
    }
  }, [index, matches, onReveal, open, scrollRef])

  const host = scrollRef.current?.parentElement?.querySelector('[data-reader-find-host]')
  if (!open || !host) return null
  return createPortal(
    <search
      data-testid="reader-find"
      onKeyDown={(event) => {
        if (!event.metaKey && !event.ctrlKey) event.stopPropagation()
      }}
      aria-label="Find in conversation"
      className="flex w-fit max-w-full flex-wrap items-center gap-2 rounded-md border border-edge bg-raised px-3 py-2 text-xs shadow-sm"
    >
      <input
        ref={inputRef}
        data-testid="reader-find-input"
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        className="w-44 min-w-0 bg-transparent text-ink outline-none"
      />
      <span data-testid="reader-find-count" role="status" className="min-w-16 text-ink-dim tabular-nums">
        {query.trim() ? (matches.length ? `${index + 1} of ${matches.length}` : 'No matches') : ''}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        disabled={!matches.length}
        onClick={() => move(-1)}
        className="rounded px-2 py-1 hover:bg-active disabled:opacity-40"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        disabled={!matches.length}
        onClick={() => move(1)}
        className="rounded px-2 py-1 hover:bg-active disabled:opacity-40"
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Close find"
        onClick={close}
        className="rounded px-2 py-1 hover:bg-active"
      >
        ×
      </button>
      {incomplete && (
        <span className="w-full text-ink-faint">
          Some message bodies are not loaded. Results may be incomplete.
        </span>
      )}
    </search>,
    host
  )
}
