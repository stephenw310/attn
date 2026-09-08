import { useEffect, useRef } from 'react'
import type { HighlightedOption } from '../hooks/useHighlightedOption'
import { ScrapEdge } from './Hand'

interface PickerDialogProps {
  testId: string
  ariaLabel: string
  searchTestId: string
  searchPlaceholder: string
  optionsTestId: string
  /** The keystroke legend along the bottom edge. */
  footer: string
  query: string
  onQuery: (query: string) => void
  highlight: HighlightedOption
  /** Enter on the highlighted option. */
  onChoose: () => void
  onClose: () => void
  children: React.ReactNode
}

/**
 * The shell the label and move pickers share: a pointer-dismissable backdrop,
 * a modal dialog that claims Escape during capture so no list shortcut sees
 * it, a search field that drives the highlight, and the scrolling option list.
 */
export function PickerDialog({
  testId,
  ariaLabel,
  searchTestId,
  searchPlaceholder,
  optionsTestId,
  footer,
  query,
  onQuery,
  highlight,
  onChoose,
  onClose,
  children
}: PickerDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the focused search input handles Escape */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the conventional pointer-only backdrop */}
      <div className="fixed inset-0 z-[60] bg-overlay" onClick={onClose} />
      <section
        data-testid={testId}
        role="dialog"
        aria-label={ariaLabel}
        aria-modal="true"
        className="fixed top-[18vh] left-1/2 isolate z-[70] flex w-[min(460px,90vw)] -translate-x-1/2 flex-col px-4 py-4"
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <ScrapEdge />
        <div className="border-b border-edge p-3">
          <input
            ref={inputRef}
            data-testid={searchTestId}
            type="search"
            value={query}
            onChange={(event) => {
              onQuery(event.target.value)
              highlight.reset()
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                highlight.move(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                highlight.move(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                onChoose()
              }
            }}
            placeholder={searchPlaceholder}
            className="w-full border border-edge bg-ground px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
        <div data-testid={optionsTestId} className="max-h-[320px] overflow-y-auto p-1.5">
          {children}
        </div>
        <div className="border-t border-edge px-4 py-2 text-xs text-ink-faint">{footer}</div>
      </section>
    </>
  )
}
