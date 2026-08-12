import { useEffect, useMemo, useRef, useState } from 'react'
import type { MailLabel } from '../../shared/mail'

export type LabelCheckState = 'all' | 'some' | 'off'

export interface LabelTarget {
  id: string
  labelIds: readonly string[]
}

interface LabelPickerProps {
  labels: readonly MailLabel[]
  targets: readonly LabelTarget[]
  onClose: () => void
  onToggle: (label: MailLabel, state: LabelCheckState) => void
}

function checkState(labelId: string, targets: readonly LabelTarget[]): LabelCheckState {
  const count = targets.filter((target) => target.labelIds.includes(labelId)).length
  if (count === 0) return 'off'
  return count === targets.length ? 'all' : 'some'
}

export function LabelPicker({ labels, targets, onClose, onToggle }: LabelPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? labels.filter((label) => label.name.toLocaleLowerCase().includes(normalized)) : labels
  }, [labels, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setHighlightedIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)))
  }, [filtered.length])

  useEffect(() => {
    const highlighted = filtered[highlightedIndex]
    if (highlighted) optionRefs.current.get(highlighted.id)?.scrollIntoView({ block: 'nearest' })
  }, [filtered, highlightedIndex])

  const toggleHighlighted = (): void => {
    const label = filtered[highlightedIndex]
    if (label) onToggle(label, checkState(label.id, targets))
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the focused search input handles Escape */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the conventional pointer-only backdrop */}
      <div className="fixed inset-0 z-[60] bg-[rgba(8,9,11,0.72)]" onClick={onClose} />
      <section
        data-testid="label-picker"
        role="dialog"
        aria-label="Label conversations"
        aria-modal="true"
        className="fixed top-[18vh] left-1/2 z-[70] flex w-[min(460px,90vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.68)]"
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <div className="border-b border-edge p-3">
          <input
            ref={inputRef}
            data-testid="label-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlightedIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlightedIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlightedIndex((index) =>
                  filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length
                )
              } else if (event.key === 'Enter') {
                event.preventDefault()
                toggleHighlighted()
              }
            }}
            placeholder="Search labels…"
            className="w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
        <div data-testid="label-options" className="max-h-[320px] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-ink-faint">No matching labels</div>
          ) : (
            filtered.map((label, index) => {
              const state = checkState(label.id, targets)
              return (
                <button
                  key={label.id}
                  ref={(element) => {
                    if (element) optionRefs.current.set(label.id, element)
                    else optionRefs.current.delete(label.id)
                  }}
                  type="button"
                  data-testid="label-option"
                  data-label-id={label.id}
                  data-state={state}
                  data-highlighted={index === highlightedIndex || undefined}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => onToggle(label, state)}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                    index === highlightedIndex ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/60'
                  }`}
                >
                  <span
                    className={`flex size-4 items-center justify-center rounded border text-[11px] font-bold ${
                      state === 'off' ? 'border-edge text-transparent' : 'border-accent bg-accent text-ground'
                    }`}
                    aria-hidden
                  >
                    {state === 'some' ? '−' : '✓'}
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{label.name}</span>
                  {state === 'some' && <span className="text-xs text-ink-faint">some</span>}
                </button>
              )
            })
          )}
        </div>
        <div className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
          ↑↓ navigate · Enter toggle · Esc close
        </div>
      </section>
    </>
  )
}
