import { Fragment, useMemo, useState } from 'react'
import type { MailLabel } from '../../shared/mail'
import { type MoveDestination, moveLabelDelta } from '../../shared/move'
import { PickerDialog } from './components/PickerDialog'
import { useHighlightedOption } from './hooks/useHighlightedOption'
import { labelMarkerColor } from './list/labelColor'

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

  const optionIds = useMemo(() => options.map((option) => option.id), [options])
  const highlight = useHighlightedOption(optionIds)

  const moveHighlighted = (): void => {
    const option = options[highlight.index]
    if (option && !option.disabled) onMove(option.destination)
  }

  return (
    <PickerDialog
      testId="move-picker"
      ariaLabel="Move or mark conversations"
      title={targets.length > 1 ? `Move ${targets.length} conversations` : 'Move conversation'}
      searchTestId="move-search"
      searchPlaceholder="Search…"
      optionsTestId="move-options"
      query={query}
      onQuery={setQuery}
      highlight={highlight}
      onChoose={moveHighlighted}
      onClose={onClose}
    >
      {options.map((option, index) => {
        const startsGroup = index === 0 || options[index - 1]?.group !== option.group
        return (
          <Fragment key={option.id}>
            {startsGroup && (
              <div
                data-testid={`move-section-${option.group}`}
                className={`px-3 pb-1 text-xs font-medium text-ink-dim ${
                  index === 0 ? 'pt-1' : 'mt-1 border-t border-dialog-edge pt-2.5'
                }`}
              >
                {option.group === 'destinations'
                  ? 'Destinations'
                  : option.group === 'importance'
                    ? 'Importance'
                    : 'Labels'}
              </div>
            )}
            <button
              ref={highlight.optionRef(option.id)}
              type="button"
              data-testid={option.labelId ? 'move-option' : `move-${option.id}`}
              data-label-id={option.labelId}
              data-destination-kind={option.destination.kind}
              data-highlighted={index === highlight.index || undefined}
              disabled={option.disabled}
              onMouseEnter={() => highlight.setIndex(index)}
              onClick={() => onMove(option.destination)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
                index === highlight.index ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/60'
              }`}
            >
              <span
                className={`flex size-4 items-center justify-center text-sm ${
                  option.id === 'done' ? 'text-status-live' : 'text-ink-faint'
                }`}
                aria-hidden
              >
                {option.labelId ? (
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: labelMarkerColor(option.labelId) }}
                  />
                ) : (
                  option.icon
                )}
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
    </PickerDialog>
  )
}
