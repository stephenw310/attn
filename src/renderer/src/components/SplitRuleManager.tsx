import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type ButtonHTMLAttributes, type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import {
  IMPORTANT_SPLIT_ID,
  OTHER_SPLIT_ID,
  type SaveSplitInput,
  type SplitCondition,
  type SplitPresetId,
  type SplitRule,
  type SplitState,
  type SplitSummary
} from '../../../shared/splits'
import { ScrapEdge } from './Hand'

interface SplitRuleManagerProps {
  state: SplitState
  onSave: (input: SaveSplitInput) => Promise<void>
  onNotify: (id: string, notify: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (ids: string[]) => Promise<void>
  onRestore: (id: SplitPresetId) => Promise<void>
  onClose: () => void
}

const CONDITION_LABELS: Record<SplitCondition['type'], string> = {
  senderAddress: 'Sender address',
  senderDomain: 'Sender domain',
  listId: 'Exact List-Id',
  listIdPresent: 'Has List-Id',
  label: 'Gmail label',
  attachmentMimeType: 'Attachment MIME type',
  attachmentFilenameSuffix: 'Filename suffix'
}

const CONDITION_TYPES = Object.keys(CONDITION_LABELS) as SplitCondition['type'][]
const PRESET_NAMES: Record<SplitPresetId, string> = {
  'preset:calendar': 'Calendar',
  'preset:github': 'GitHub',
  'preset:newsletters': 'Newsletters'
}

interface RuleDraft {
  id?: string
  name: string
  operator: 'any' | 'all'
  conditions: DraftCondition[]
  notify: boolean
}

interface DraftCondition {
  key: string
  condition: SplitCondition
}

let nextConditionKey = 0

const noop = (): void => undefined

function draftCondition(condition: SplitCondition): DraftCondition {
  nextConditionKey += 1
  return { key: `condition-${nextConditionKey}`, condition }
}

function draftFor(rule?: SplitRule): RuleDraft {
  return rule
    ? {
        id: rule.id,
        name: rule.name,
        operator: rule.match.operator,
        conditions: rule.match.conditions.map((condition) => draftCondition({ ...condition })),
        notify: rule.notify
      }
    : {
        name: '',
        operator: 'any',
        conditions: [draftCondition({ type: 'senderDomain', value: '' })],
        notify: false
      }
}

function conditionNeedsValue(
  condition: SplitCondition
): condition is Exclude<SplitCondition, { type: 'listIdPresent' }> {
  return condition.type !== 'listIdPresent'
}

interface SplitRuleRowProps {
  split: SplitSummary
  index: number
  busy: boolean
  rowRef?: (element: HTMLLIElement | null) => void
  rowStyle?: CSSProperties
  handleRef?: (element: HTMLButtonElement | null) => void
  handleProps?: ButtonHTMLAttributes<HTMLButtonElement>
  isDragSource?: boolean
  isDropTarget?: boolean
  isOverlay?: boolean
  onNotify: (notify: boolean) => void
  onEdit: () => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
}

function SplitRuleRow(props: SplitRuleRowProps): React.JSX.Element {
  const {
    split,
    index,
    busy,
    rowRef,
    rowStyle,
    handleRef,
    handleProps,
    isDragSource = false,
    isDropTarget = false,
    isOverlay = false,
    onNotify,
    onEdit,
    onDelete,
    onMove
  } = props
  const fallback = split.id === OTHER_SPLIT_ID
  const readOnlyMatch = split.id === IMPORTANT_SPLIT_ID || fallback

  return (
    <li
      ref={rowRef}
      data-testid={isOverlay ? 'split-rule-drag-overlay' : 'split-rule'}
      data-split-id={split.id}
      data-dragging={isDragSource ? 'true' : 'false'}
      data-drop-target={isDropTarget ? 'true' : 'false'}
      aria-hidden={isOverlay || undefined}
      inert={isOverlay || undefined}
      style={rowStyle}
      className={`relative grid min-h-[72px] grid-cols-[36px_minmax(0,1fr)_96px_112px] items-center gap-3 border px-3 transition-[border-color,background-color,box-shadow,opacity] ${
        isOverlay
          ? 'z-70 cursor-grabbing border-accent bg-raised shadow-dialog'
          : isDragSource
            ? 'opacity-0'
            : isDropTarget
              ? 'border-accent bg-active'
              : 'border-edge bg-ground/45'
      }`}
    >
      {!fallback ? (
        <button
          {...handleProps}
          ref={handleRef}
          type="button"
          data-testid="split-rule-drag-handle"
          aria-label={`Reorder ${split.name}`}
          aria-describedby="split-reorder-help"
          disabled={busy}
          tabIndex={isOverlay ? -1 : handleProps?.tabIndex}
          onKeyDown={(event) => {
            handleProps?.onKeyDown?.(event)
            if (event.defaultPrevented) return
            if (isDragSource) return
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              onMove(-1)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              onMove(1)
            }
          }}
          className="flex size-8 touch-none cursor-grab items-center justify-center text-ink-faint hover:bg-active hover:text-ink active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-current">
            <circle cx="5" cy="3" r="1.25" />
            <circle cx="11" cy="3" r="1.25" />
            <circle cx="5" cy="8" r="1.25" />
            <circle cx="11" cy="8" r="1.25" />
            <circle cx="5" cy="13" r="1.25" />
            <circle cx="11" cy="13" r="1.25" />
          </svg>
        </button>
      ) : (
        <span aria-hidden="true" className="size-8" />
      )}
      <div data-testid="split-rule-summary" className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-ink">{split.name}</span>
          <span className="text-[10px] tabular-nums text-ink-faint">
            {split.total.toLocaleString()} total, {split.unread.toLocaleString()} unread
          </span>
        </div>
        <p className="truncate text-[11px] text-ink-faint">
          {fallback
            ? 'Everything that did not match an earlier split'
            : `${split.match.operator === 'all' ? 'All' : 'Any'} of ${split.match.conditions.length} conditions`}
        </p>
      </div>
      <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-dim">
        <input
          data-testid="split-rule-notify"
          type="checkbox"
          checked={split.notify}
          disabled={busy}
          onChange={(event) => onNotify(event.target.checked)}
        />
        Notify
      </label>
      {readOnlyMatch ? (
        <span data-testid="split-rule-action" className="w-28 text-right text-[10px] text-ink-faint">
          {fallback ? 'Always last' : 'Built in'}
        </span>
      ) : (
        <div data-testid="split-rule-action" className="flex w-28 items-center justify-end gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="h-8 cursor-pointer px-2 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          >
            Edit
          </button>
          <button
            type="button"
            data-testid="split-rule-delete"
            aria-label={`Delete ${split.name}`}
            disabled={busy}
            onClick={onDelete}
            className="size-8 cursor-pointer text-ink-faint hover:bg-danger hover:text-on-danger"
          >
            ×
          </button>
        </div>
      )}
      <span className="sr-only">Position {index + 1}</span>
    </li>
  )
}

function SortableSplitRuleRow(props: SplitRuleRowProps): React.JSX.Element {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({ id: props.split.id, disabled: props.busy })
  return (
    <SplitRuleRow
      {...props}
      rowRef={setNodeRef}
      rowStyle={{ transform: CSS.Transform.toString(transform), transition }}
      handleRef={setActivatorNodeRef}
      handleProps={{ ...attributes, ...listeners }}
      isDragSource={isDragging}
      isDropTarget={isOver && !isDragging}
    />
  )
}

export function SplitRuleManager(props: SplitRuleManagerProps): React.JSX.Element {
  const { state, onSave, onNotify, onDelete, onReorder, onRestore, onClose } = props
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const nameInputRef = useRef<HTMLInputElement>(null)
  const editorOpen = draft !== null
  const matchingSplits = useMemo(
    () => state.splits.filter((split) => split.id !== OTHER_SPLIT_ID),
    [state.splits]
  )
  const authoritativeOrder = useMemo(() => matchingSplits.map((split) => split.id), [matchingSplits])
  const authoritativeOrderKey = authoritativeOrder.join('\u0000')
  const [orderedIds, setOrderedIds] = useState(authoritativeOrder)
  const authoritativeOrderRef = useRef(authoritativeOrder)
  authoritativeOrderRef.current = authoritativeOrder
  const orderedIdsRef = useRef(orderedIds)
  orderedIdsRef.current = orderedIds
  const draggingIdRef = useRef(draggingId)
  draggingIdRef.current = draggingId
  const splitById = useMemo(() => new Map(matchingSplits.map((split) => [split.id, split])), [matchingSplits])
  const orderedSplits = useMemo(() => {
    const ordered = orderedIds.flatMap((id) => {
      const split = splitById.get(id)
      return split ? [split] : []
    })
    const seen = new Set(ordered.map((split) => split.id))
    return [...ordered, ...matchingSplits.filter((split) => !seen.has(split.id))]
  }, [matchingSplits, orderedIds, splitById])
  const fallbackSplit = state.splits.find((split) => split.id === OTHER_SPLIT_ID)
  const draggedSplit = draggingId ? splitById.get(draggingId) : undefined

  useEffect(() => {
    if (draggingIdRef.current) return
    const nextOrder = authoritativeOrderKey ? authoritativeOrderKey.split('\u0000') : []
    setOrderedIds((current) => {
      if (current.length === nextOrder.length && current.every((id, index) => id === nextOrder[index])) {
        return current
      }
      return nextOrder
    })
  }, [authoritativeOrderKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || draggingId) return
      event.preventDefault()
      if (draft) setDraft(null)
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, draggingId, onClose])

  useEffect(() => {
    if (editorOpen) nameInputRef.current?.focus()
  }, [editorOpen])

  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update splits')
      return false
    } finally {
      setBusy(false)
    }
  }

  const persistOrder = (ids: string[]): void => {
    setOrderedIds(ids)
    void run(() => onReorder(ids)).then((saved) => {
      if (!saved) setOrderedIds(authoritativeOrderRef.current)
    })
  }

  const move = (id: string, direction: -1 | 1): void => {
    if (busy) return
    const ids = [...orderedIdsRef.current]
    const index = ids.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    persistOrder(ids)
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-overlay p-8">
      <button
        type="button"
        aria-label="Dismiss split rules"
        data-testid="split-rules-backdrop"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-rules-title"
        data-testid="split-rules"
        className="relative isolate flex max-h-[min(720px,90vh)] w-full max-w-3xl flex-col"
      >
        <ScrapEdge />
        <header className="flex h-14 flex-none items-center border-b border-edge px-5">
          <div>
            <h2 id="split-rules-title" className="text-sm font-semibold text-ink">
              Split inbox
            </h2>
            <p className="text-[11px] text-ink-faint">First matching split wins. Other is always last.</p>
          </div>
          <button
            type="button"
            aria-label="Close split rules"
            onClick={onClose}
            className="ml-auto size-8 cursor-pointer text-xl text-ink-faint hover:bg-active hover:text-ink"
          >
            ×
          </button>
        </header>

        {draft ? (
          <form
            data-testid="split-rule-editor"
            className="min-h-0 flex-1 overflow-y-auto p-5"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await onSave({
                  ...draft,
                  conditions: draft.conditions.map(({ condition }) => condition)
                })
                setDraft(null)
              })
            }}
          >
            <label className="block text-xs font-semibold text-ink-dim">
              Name
              <input
                ref={nameInputRef}
                data-testid="split-rule-name"
                value={draft.name}
                maxLength={64}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className="mt-1.5 h-9 w-full border border-edge bg-ground px-3 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
            <div className="mt-4 flex items-center gap-3">
              <label className="text-xs font-semibold text-ink-dim" htmlFor="split-operator">
                Match
              </label>
              <select
                id="split-operator"
                data-testid="split-rule-operator"
                value={draft.operator}
                onChange={(event) =>
                  setDraft({ ...draft, operator: event.target.value === 'all' ? 'all' : 'any' })
                }
                className="h-8 border border-edge bg-ground px-2 text-xs text-ink"
              >
                <option value="any">Any condition</option>
                <option value="all">All conditions on one message</option>
              </select>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {draft.conditions.map(({ key, condition }, index) => (
                <div key={key} data-testid="split-rule-condition" className="flex gap-2">
                  <select
                    aria-label={`Condition ${index + 1} type`}
                    value={condition.type}
                    onChange={(event) => {
                      const type = event.target.value as SplitCondition['type']
                      const next: SplitCondition = type === 'listIdPresent' ? { type } : { type, value: '' }
                      const conditions = [...draft.conditions]
                      conditions[index] = { key, condition: next }
                      setDraft({ ...draft, conditions })
                    }}
                    className="h-9 w-52 border border-edge bg-ground px-2 text-xs text-ink"
                  >
                    {CONDITION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {CONDITION_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  {conditionNeedsValue(condition) ? (
                    <input
                      aria-label={`Condition ${index + 1} value`}
                      value={condition.value}
                      onChange={(event) => {
                        const conditions = [...draft.conditions]
                        conditions[index] = {
                          key,
                          condition: { ...condition, value: event.target.value }
                        }
                        setDraft({ ...draft, conditions })
                      }}
                      placeholder={condition.type === 'label' ? 'IMPORTANT' : 'Value'}
                      className="h-9 min-w-0 flex-1 border border-edge bg-ground px-3 text-sm text-ink outline-none focus:border-accent"
                    />
                  ) : (
                    <div className="flex h-9 min-w-0 flex-1 items-center px-3 text-xs text-ink-faint">
                      Matches any stored List-Id header
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove condition ${index + 1}`}
                    disabled={draft.conditions.length === 1}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        conditions: draft.conditions.filter((_, conditionIndex) => conditionIndex !== index)
                      })
                    }
                    className="size-9 cursor-pointer text-ink-faint hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  conditions: [...draft.conditions, draftCondition({ type: 'senderDomain', value: '' })]
                })
              }
              className="mt-3 cursor-pointer text-xs font-semibold text-accent hover:underline"
            >
              Add condition
            </button>
            <label className="mt-5 flex items-center gap-2 text-xs text-ink-dim">
              <input
                type="checkbox"
                checked={draft.notify}
                onChange={(event) => setDraft({ ...draft, notify: event.target.checked })}
              />
              Show native notifications for this split
            </label>
            <p className="mt-4 border border-edge bg-ground/60 p-3 text-[11px] leading-5 text-ink-faint">
              Attachment rules use cached message metadata. After a database upgrade, Attn refreshes older
              Inbox metadata in the background. Reading a split never starts a network request.
            </p>
            {error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {error}
              </p>
            )}
            <footer className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
                className="h-9 cursor-pointer px-4 text-xs font-semibold text-ink-dim hover:bg-active"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="h-9 cursor-pointer bg-accent px-4 text-xs font-semibold text-on-accent disabled:opacity-50"
              >
                Save split
              </button>
            </footer>
          </form>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p id="split-reorder-help" className="sr-only">
              Drag a handle to reorder splits. With a handle focused, use the Up and Down arrow keys.
            </p>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={(event) => setDraggingId(String(event.active.id))}
              onDragCancel={() => {
                setDraggingId(null)
                setOrderedIds(authoritativeOrderRef.current)
              }}
              onDragEnd={(event) => {
                setDraggingId(null)
                if (!event.over || event.active.id === event.over.id) return
                const currentIds = orderedIdsRef.current
                const from = currentIds.indexOf(String(event.active.id))
                const to = currentIds.indexOf(String(event.over.id))
                if (from < 0 || to < 0) return
                const ids = arrayMove(currentIds, from, to)
                persistOrder(ids)
              }}
            >
              <ol className="flex flex-col gap-2">
                <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                  {orderedSplits.map((split, index) => (
                    <SortableSplitRuleRow
                      key={split.id}
                      split={split}
                      index={index}
                      busy={busy}
                      onNotify={(notify) => void run(() => onNotify(split.id, notify))}
                      onEdit={() => setDraft(draftFor(split))}
                      onDelete={() => void run(() => onDelete(split.id))}
                      onMove={(direction) => move(split.id, direction)}
                    />
                  ))}
                </SortableContext>
                {fallbackSplit && (
                  <SplitRuleRow
                    split={fallbackSplit}
                    index={orderedSplits.length}
                    busy={busy}
                    onNotify={(notify) => void run(() => onNotify(fallbackSplit.id, notify))}
                    onEdit={noop}
                    onDelete={noop}
                    onMove={noop}
                  />
                )}
              </ol>
              <DragOverlay adjustScale={false} dropAnimation={{ duration: 180, easing: 'ease-out' }}>
                {draggedSplit ? (
                  <SplitRuleRow
                    split={draggedSplit}
                    index={Math.max(0, orderedIds.indexOf(draggedSplit.id))}
                    busy={true}
                    isOverlay={true}
                    onNotify={noop}
                    onEdit={noop}
                    onDelete={noop}
                    onMove={noop}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
              <button
                type="button"
                onClick={() => setDraft(draftFor())}
                className="h-9 cursor-pointer bg-accent px-4 text-xs font-semibold text-on-accent"
              >
                New split
              </button>
              {state.restorablePresetIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  data-testid="split-rule-restore"
                  disabled={busy}
                  onClick={() => void run(() => onRestore(id))}
                  className="h-9 cursor-pointer border border-edge px-3 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
                >
                  Restore {PRESET_NAMES[id]}
                </button>
              ))}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
