import { useEffect, useMemo, useRef, useState } from 'react'
import type { MailLabel } from '../../shared/mail'

export interface MoveTarget {
  id: string
  labelIds: readonly string[]
  snoozed: boolean
  returned: boolean
}

interface MovePickerProps {
  labels: readonly MailLabel[]
  targets: readonly MoveTarget[]
  sourceLabelId: string | null
  onClose: () => void
  onMove: (destinationLabelId: string | null) => void
}

interface MoveOption {
  id: string
  label: string
  destinationLabelId: string | null
  disabled: boolean
}

function doneIsDisabled(targets: readonly MoveTarget[], sourceLabelId: string | null): boolean {
  return targets.every(
    (target) =>
      !target.labelIds.includes('INBOX') &&
      (!sourceLabelId || !target.labelIds.includes(sourceLabelId)) &&
      !target.snoozed &&
      !target.returned
  )
}

export function MovePicker({
  labels,
  targets,
  sourceLabelId,
  onClose,
  onMove
}: MovePickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredLabels = useMemo(() => {
    return labels.filter(
      (label) =>
        label.id !== sourceLabelId &&
        (!normalizedQuery || label.name.toLocaleLowerCase().includes(normalizedQuery))
    )
  }, [labels, normalizedQuery, sourceLabelId])
  const options = useMemo<readonly MoveOption[]>(() => {
    const showDone = labels.length === 0 || !normalizedQuery || 'done'.includes(normalizedQuery)
    return [
      ...(showDone
        ? [
            {
              id: 'done',
              label: 'Done',
              destinationLabelId: null,
              disabled: doneIsDisabled(targets, sourceLabelId)
            }
          ]
        : []),
      ...filteredLabels.map((label) => ({
        id: label.id,
        label: label.name,
        destinationLabelId: label.id,
        disabled: false
      }))
    ]
  }, [filteredLabels, labels.length, normalizedQuery, sourceLabelId, targets])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setHighlightedIndex((index) => Math.min(index, Math.max(options.length - 1, 0)))
  }, [options.length])

  useEffect(() => {
    const highlighted = options[highlightedIndex]
    if (highlighted) optionRefs.current.get(highlighted.id)?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, options])

  const moveHighlighted = (): void => {
    const option = options[highlightedIndex]
    if (option && !option.disabled) onMove(option.destinationLabelId)
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the focused search input handles Escape */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the conventional pointer-only backdrop */}
      <div className="fixed inset-0 z-[60] bg-overlay" onClick={onClose} />
      <section
        data-testid="move-picker"
        role="dialog"
        aria-label="Move conversations"
        aria-modal="true"
        className="fixed top-[18vh] left-1/2 z-[70] flex w-[min(460px,90vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-dialog"
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
            data-testid="move-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlightedIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlightedIndex((index) => (options.length === 0 ? 0 : (index + 1) % options.length))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlightedIndex((index) =>
                  options.length === 0 ? 0 : (index - 1 + options.length) % options.length
                )
              } else if (event.key === 'Enter') {
                event.preventDefault()
                moveHighlighted()
              }
            }}
            placeholder="Move to…"
            className="w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
        <div data-testid="move-options" className="max-h-[320px] overflow-y-auto p-1.5">
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => {
                if (element) optionRefs.current.set(option.id, element)
                else optionRefs.current.delete(option.id)
              }}
              type="button"
              data-testid={option.id === 'done' ? 'move-done' : 'move-option'}
              data-label-id={option.destinationLabelId ?? undefined}
              data-highlighted={index === highlightedIndex || undefined}
              disabled={option.disabled}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => onMove(option.destinationLabelId)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                index === highlightedIndex ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/60'
              }`}
            >
              <span
                className={`flex size-4 items-center justify-center text-sm ${
                  option.id === 'done' ? 'text-positive' : 'text-ink-faint'
                }`}
                aria-hidden
              >
                {option.id === 'done' ? '✓' : '→'}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{option.label}</span>
            </button>
          ))}
          {filteredLabels.length === 0 && labels.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-ink-faint">
              Create labels in Gmail to add more destinations.
            </div>
          )}
          {filteredLabels.length === 0 && labels.length > 0 && query.trim() && (
            <div className="px-3 py-4 text-center text-xs text-ink-faint">No matching labels</div>
          )}
        </div>
        <div className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
          ↑↓ navigate · Enter move · Esc close
        </div>
      </section>
    </>
  )
}
