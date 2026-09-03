import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { MailLabel } from '../../shared/mail'
import { type MoveDestination, moveLabelDelta } from '../../shared/move'

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
  showImportanceActions: boolean
  onClose: () => void
  onMove: (destination: MoveDestination) => void
}

interface MoveOption {
  id: string
  label: string
  destination: MoveDestination
  group: 'destinations' | 'importance' | 'labels'
  labelId?: string
  icon: string
  disabled: boolean
}

function importanceActionApplies(destination: MoveDestination, targets: readonly MoveTarget[]): boolean {
  if (destination.kind === 'important') {
    return targets.some((target) => !target.labelIds.includes('IMPORTANT'))
  }
  if (destination.kind === 'other') {
    return targets.some((target) => target.labelIds.includes('IMPORTANT'))
  }
  return false
}

function destinationIsDisabled(
  destination: MoveDestination,
  targets: readonly MoveTarget[],
  sourceLabelId: string | null
): boolean {
  const delta = moveLabelDelta(destination, sourceLabelId)
  return targets.every((target) => {
    const changesLabels =
      delta.add.some((labelId) => !target.labelIds.includes(labelId)) ||
      delta.remove.some((labelId) => target.labelIds.includes(labelId))
    return !changesLabels && !target.snoozed && !target.returned
  })
}

export function MovePicker({
  labels,
  targets,
  sourceLabelId,
  showImportanceActions,
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
    const systemOptions: Array<Omit<MoveOption, 'disabled'>> = [
      {
        id: 'done',
        label: 'Done',
        destination: { kind: 'done' },
        group: 'destinations',
        icon: '✓'
      },
      {
        id: 'inbox',
        label: 'Inbox',
        destination: { kind: 'inbox' },
        group: 'destinations',
        icon: '→'
      },
      { id: 'spam', label: 'Spam', destination: { kind: 'spam' }, group: 'destinations', icon: '→' },
      {
        id: 'trash',
        label: 'Trash',
        destination: { kind: 'trash' },
        group: 'destinations',
        icon: '→'
      }
    ]
    const destinationOptions: MoveOption[] = systemOptions
      .filter((option) => !normalizedQuery || option.label.toLocaleLowerCase().includes(normalizedQuery))
      .map((option) => ({
        ...option,
        disabled: destinationIsDisabled(option.destination, targets, sourceLabelId)
      }))
    const labelOptions: MoveOption[] = filteredLabels.map((label) => ({
      id: label.id,
      label: label.name,
      destination: { kind: 'label' as const, labelId: label.id },
      group: 'labels' as const,
      labelId: label.id,
      icon: '→',
      disabled: destinationIsDisabled({ kind: 'label', labelId: label.id }, targets, sourceLabelId)
    }))
    const importanceOptions: MoveOption[] = showImportanceActions
      ? (
          [
            {
              id: 'mark-important',
              label: 'Mark as important',
              destination: { kind: 'important' },
              group: 'importance',
              icon: '!',
              disabled: false
            },
            {
              id: 'mark-not-important',
              label: 'Mark as not important',
              destination: { kind: 'other' },
              group: 'importance',
              icon: '−',
              disabled: false
            }
          ] satisfies MoveOption[]
        ).filter(
          (option) =>
            (!normalizedQuery || option.label.toLocaleLowerCase().includes(normalizedQuery)) &&
            importanceActionApplies(option.destination, targets)
        )
      : []
    return [...destinationOptions, ...importanceOptions, ...labelOptions]
  }, [filteredLabels, normalizedQuery, showImportanceActions, sourceLabelId, targets])

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
    if (option && !option.disabled) onMove(option.destination)
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the focused search input handles Escape */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the conventional pointer-only backdrop */}
      <div className="fixed inset-0 z-[60] bg-overlay" onClick={onClose} />
      <section
        data-testid="move-picker"
        role="dialog"
        aria-label="Move or mark conversations"
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
            placeholder="Search…"
            className="w-full rounded-lg border border-edge bg-ground px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
        <div data-testid="move-options" className="max-h-[320px] overflow-y-auto p-1.5">
          {options.map((option, index) => {
            const startsGroup = index === 0 || options[index - 1]?.group !== option.group
            return (
              <Fragment key={option.id}>
                {startsGroup && (
                  <div
                    data-testid={`move-section-${option.group}`}
                    className={`px-3 pb-1 text-[10px] font-semibold tracking-[0.14em] text-ink-faint uppercase ${
                      index === 0 ? 'pt-1' : 'mt-1 border-t border-edge pt-2.5'
                    }`}
                  >
                    {option.group === 'destinations'
                      ? 'Move to'
                      : option.group === 'importance'
                        ? 'Importance'
                        : 'Labels'}
                  </div>
                )}
                <button
                  ref={(element) => {
                    if (element) optionRefs.current.set(option.id, element)
                    else optionRefs.current.delete(option.id)
                  }}
                  type="button"
                  data-testid={option.labelId ? 'move-option' : `move-${option.id}`}
                  data-label-id={option.labelId}
                  data-destination-kind={option.destination.kind}
                  data-highlighted={index === highlightedIndex || undefined}
                  disabled={option.disabled}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => onMove(option.destination)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                    index === highlightedIndex ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/60'
                  }`}
                >
                  <span
                    className={`flex size-4 items-center justify-center text-sm ${
                      option.id === 'done' ? 'text-status-live' : 'text-ink-faint'
                    }`}
                    aria-hidden
                  >
                    {option.icon}
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{option.label}</span>
                </button>
              </Fragment>
            )
          })}
          {filteredLabels.length === 0 && labels.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-ink-faint">
              Create labels in Gmail to add more destinations.
            </div>
          )}
          {options.length === 0 && query.trim() && (
            <div className="px-3 py-4 text-center text-xs text-ink-faint">No matching options</div>
          )}
        </div>
        <div className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
          ↑↓ navigate · Enter choose · Esc close
        </div>
      </section>
    </>
  )
}
