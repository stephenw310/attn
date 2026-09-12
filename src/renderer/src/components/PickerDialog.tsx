import { useEffect, useRef } from 'react'
import type { HighlightedOption } from '../hooks/useHighlightedOption'
import { PickerHeading, PickerLegend } from './PickerChrome'

interface PickerDialogProps {
  testId: string
  ariaLabel: string
  searchTestId: string
  searchPlaceholder: string
  optionsTestId: string
  /** Enter toggles labels but chooses a move destination. */
  actionLabel?: 'Toggle' | 'Choose'
  title?: string
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
  actionLabel = 'Choose',
  title,
  query,
  onQuery,
  highlight,
  onChoose,
  onClose,
  children
}: PickerDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const previous = document.activeElement
    inputRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
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
        className="fixed top-[12vh] left-1/2 z-[70] flex max-h-[80vh] w-[min(540px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-dialog-edge bg-raised shadow-dialog"
        onKeyDownCapture={(event) => {
          if (event.key === 'Tab') {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input')
            )
            const next =
              controls[
                (controls.indexOf(document.activeElement as HTMLElement) +
                  (event.shiftKey ? -1 : 1) +
                  controls.length) %
                  controls.length
              ]
            event.preventDefault()
            next?.focus()
            return
          }
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <PickerHeading title={title ?? ariaLabel} onClose={onClose} />
        <div className="mx-6 mb-2 flex items-center gap-3 border-b border-dialog-edge py-3">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0 fill-none stroke-ink-dim">
            <circle cx="10.5" cy="10.5" r="6.5" strokeWidth="1.8" />
            <path d="m15.5 15.5 4 4" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
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
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-dim"
          />
        </div>
        <div data-testid={optionsTestId} className="min-h-0 max-h-[360px] overflow-y-auto px-2.5 pb-3">
          {children}
        </div>
        <PickerLegend action={actionLabel} />
      </section>
    </>
  )
}
