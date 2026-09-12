import { useMemo, useState } from 'react'
import type { MailLabel } from '../../shared/mail'
import { PickerDialog } from './components/PickerDialog'
import { useHighlightedOption } from './hooks/useHighlightedOption'
import { labelMarkerColor } from './list/labelColor'

export type LabelCheckState = 'all' | 'some' | 'off'

interface LabelTarget {
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
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? labels.filter((label) => label.name.toLocaleLowerCase().includes(normalized)) : labels
  }, [labels, query])
  const optionIds = useMemo(() => filtered.map((label) => label.id), [filtered])
  const highlight = useHighlightedOption(optionIds)

  const toggleHighlighted = (): void => {
    const label = filtered[highlight.index]
    if (label) onToggle(label, checkState(label.id, targets))
  }

  return (
    <PickerDialog
      testId="label-picker"
      ariaLabel="Label conversations"
      title={targets.length > 1 ? `Label ${targets.length} conversations` : 'Label conversation'}
      searchTestId="label-search"
      searchPlaceholder="Search labels…"
      optionsTestId="label-options"
      actionLabel="Toggle"
      query={query}
      onQuery={setQuery}
      highlight={highlight}
      onChoose={toggleHighlighted}
      onClose={onClose}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-ink-faint">No matching labels</div>
      ) : (
        filtered.map((label, index) => {
          const state = checkState(label.id, targets)
          return (
            <button
              key={label.id}
              ref={highlight.optionRef(label.id)}
              type="button"
              data-testid="label-option"
              data-label-id={label.id}
              data-state={state}
              aria-pressed={state === 'some' ? 'mixed' : state === 'all'}
              data-highlighted={index === highlight.index || undefined}
              onMouseEnter={() => highlight.setIndex(index)}
              onClick={() => onToggle(label, state)}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-3 text-left text-[13px] ${
                index === highlight.index ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/60'
              }`}
            >
              <span
                className={`flex size-4 items-center justify-center rounded border text-[11px] font-bold ${
                  state === 'off'
                    ? 'border-dialog-edge text-transparent'
                    : 'border-accent bg-accent text-on-accent'
                }`}
                aria-hidden
              >
                {state === 'some' ? '−' : '✓'}
              </span>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: labelMarkerColor(label.id) }}
              />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{label.name}</span>
              {state === 'some' && (
                <span className="text-xs text-ink-faint">Some selected conversations</span>
              )}
            </button>
          )
        })
      )}
    </PickerDialog>
  )
}
