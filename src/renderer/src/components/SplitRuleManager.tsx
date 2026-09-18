import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { AiSettings } from '../../../shared/ai'
import {
  IMPORTANT_SPLIT_ID,
  OTHER_SPLIT_ID,
  type SaveSplitInput,
  SPLIT_DESCRIPTION_MAX_LENGTH,
  type SplitCondition,
  type SplitPresetId,
  type SplitRule,
  type SplitState,
  type SplitSummary,
  type SplitTriageStatus
} from '../../../shared/splits'
import { SPLIT_TRIAGE_STATUS_POLL_MS } from '../tuning'
import { Kbd } from './Kbd'
import { SmartSplitsCard } from './SmartSplitsCard'

interface SplitRuleManagerProps {
  accountEmail?: string
  state: SplitState
  onSave: (input: SaveSplitInput) => Promise<void>
  onNotify: (id: string, notify: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (ids: string[]) => Promise<void>
  onRestore: (id: SplitPresetId) => Promise<void>
  onClose: () => void
}

/**
 * Every condition this editor offers. The map stays exhaustive, so a new
 * condition fails to compile until it is labelled here.
 */
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

/** The two exclusive ways to define a split, as the editor holds them. */
type DraftMode = 'description' | 'rules'

/** One half of the editor's two-way choice. */
const MODE_BUTTON = (active: boolean): string =>
  `cursor-pointer rounded px-2.5 py-1.5 text-[11px] disabled:cursor-default disabled:opacity-40 ${
    active ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-active hover:text-ink'
  }`

/**
 * The draft keeps both sides so a mode switch is undoable until the user
 * confirms it. Only the active mode reaches `onSave`.
 */
interface RuleDraft {
  id?: string
  name: string
  mode: DraftMode
  description: string
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

function blankConditions(): DraftCondition[] {
  return [draftCondition({ type: 'senderDomain', value: '' })]
}

function draftFor(rule?: SplitRule, describeByDefault = false): RuleDraft {
  if (!rule) {
    return {
      name: '',
      mode: describeByDefault ? 'description' : 'rules',
      description: '',
      operator: 'any',
      conditions: blankConditions(),
      notify: false
    }
  }
  return {
    id: rule.id,
    name: rule.name,
    mode: rule.description !== null ? 'description' : 'rules',
    description: rule.description ?? '',
    operator: rule.match.operator,
    conditions:
      rule.match.conditions.length > 0
        ? rule.match.conditions.map((condition) => draftCondition({ ...condition }))
        : blankConditions(),
    notify: rule.notify
  }
}

function conditionNeedsValue(
  condition: SplitCondition
): condition is Exclude<SplitCondition, { type: 'listIdPresent' }> {
  return condition.type !== 'listIdPresent'
}

/** Whether the inactive side holds something the user typed, not a blank row. */
function hasContent(draft: RuleDraft, mode: DraftMode): boolean {
  if (mode === 'description') return draft.description.trim().length > 0
  return draft.conditions.some(
    ({ condition }) => !conditionNeedsValue(condition) || condition.value.trim().length > 0
  )
}

/** What a row says about the rule below its name. */
function summarize(split: SplitSummary, triageUsable: boolean): string {
  if (split.id === OTHER_SPLIT_ID) return 'Remaining Inbox mail'
  if (split.id === IMPORTANT_SPLIT_ID) return 'Gmail Important'
  if (split.description !== null) return triageUsable ? 'Described' : 'Described · paused'
  const count = split.match.conditions.length
  return `${count} ${count === 1 ? 'rule' : 'rules'}`
}

interface SplitRuleRowProps {
  split: SplitSummary
  index: number
  busy: boolean
  /** Whether a description sorts mail today; a paused one says so. */
  triageUsable: boolean
  rowRef?: (element: HTMLLIElement | null) => void
  rowStyle?: CSSProperties
  handleRef?: (element: HTMLButtonElement | null) => void
  handleProps?: ButtonHTMLAttributes<HTMLButtonElement>
  isDragSource?: boolean
  isDropTarget?: boolean
  selected?: boolean
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
    triageUsable,
    rowRef,
    rowStyle,
    handleRef,
    handleProps,
    isDragSource = false,
    isDropTarget = false,
    isOverlay = false,
    selected = false,
    onEdit,
    onMove
  } = props
  const fallback = split.id === OTHER_SPLIT_ID

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
      className={`relative grid min-h-[62px] grid-cols-[20px_minmax(0,1fr)_28px] items-center gap-2 rounded-md border border-transparent px-2 transition-[border-color,background-color,box-shadow,opacity] ${
        isOverlay
          ? 'z-70 cursor-grabbing border-accent bg-raised shadow-dialog'
          : isDragSource
            ? 'opacity-0'
            : isDropTarget
              ? 'border-accent bg-active'
              : selected
                ? 'bg-active'
                : 'hover:bg-active/40'
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
          className="flex size-5 touch-none cursor-grab items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
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
        <span aria-hidden="true" className="size-5 text-center text-ink-faint">
          ·
        </span>
      )}
      <button
        type="button"
        data-testid="split-rule-summary"
        onClick={onEdit}
        disabled={busy}
        aria-pressed={selected}
        className="min-w-0 py-3 text-left"
      >
        <span className="block truncate text-xs text-ink">{split.name}</span>
        <span className="mt-1 block truncate text-[10px] text-ink-dim">{summarize(split, triageUsable)}</span>
      </button>
      <span className="text-right text-[10px] tabular-nums text-ink-dim">
        {fallback ? 'Last' : split.unread.toLocaleString()}
      </span>
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
  const [draft, setDraft] = useState<RuleDraft | null>(() => {
    const first = state.splits[0]
    return first && first.id !== IMPORTANT_SPLIT_ID && first.id !== OTHER_SPLIT_ID ? draftFor(first) : null
  })
  const [builtInId, setBuiltInId] = useState<string>(() =>
    state.splits[0]?.id === OTHER_SPLIT_ID ? OTHER_SPLIT_ID : IMPORTANT_SPLIT_ID
  )
  const builtIn = state.splits.find((split) => split.id === builtInId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The classifier's progress and its settings feed the card, the row
  // summaries, and the editor's default mode, so one read serves all three.
  const [triageStatus, setTriageStatus] = useState<SplitTriageStatus | null>(null)
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null)
  const [modeConfirm, setModeConfirm] = useState<DraftMode | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // Whether a description actually sorts mail today.
  const triageUsable = Boolean(triageStatus?.enabled && triageStatus.keyPresent)
  const triageUsableRef = useRef(triageUsable)
  triageUsableRef.current = triageUsable
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
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draggingId, onClose])

  useEffect(() => {
    if (editorOpen && !draft?.id) nameInputRef.current?.focus()
  }, [editorOpen, draft?.id])

  const triageRequestRef = useRef(0)
  const refreshTriage = useCallback(async (): Promise<void> => {
    const bridge = window.attn
    if (!bridge) return
    const request = ++triageRequestRef.current
    const [status, settings] = await Promise.all([bridge.splits.getTriageStatus(), bridge.ai.getSettings()])
    if (request !== triageRequestRef.current) return
    setTriageStatus(status)
    setAiSettings(settings)
  }, [])
  const reloadTriage = useCallback((): void => {
    void refreshTriage().catch(() => {})
  }, [refreshTriage])

  // A judgment changes mail, so the same broadcast that refreshes the splits
  // refreshes the progress line.
  useEffect(() => {
    reloadTriage()
    return window.attn?.mail.onChanged(reloadTriage)
  }, [reloadTriage])

  const judging = (triageStatus?.pendingThreads ?? 0) > 0
  useEffect(() => {
    if (!judging) return
    const timer = setInterval(reloadTriage, SPLIT_TRIAGE_STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [judging, reloadTriage])

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

  /** Switches the editor, after asking about anything the other side would lose. */
  const applyMode = (mode: DraftMode): void => {
    setModeConfirm(null)
    setDraft((current) =>
      current
        ? {
            ...current,
            mode,
            description: mode === 'description' ? current.description : '',
            operator: mode === 'rules' ? current.operator : 'any',
            conditions: mode === 'rules' ? current.conditions : blankConditions()
          }
        : current
    )
  }

  const requestMode = (mode: DraftMode): void => {
    if (!draft || draft.mode === mode) return
    if (hasContent(draft, draft.mode)) setModeConfirm(mode)
    else applyMode(mode)
  }

  return (
    <div className="app-split-rules fixed inset-x-0 bottom-0 top-14 z-40 flex items-center justify-center bg-ground px-7 py-8">
      <button
        type="button"
        aria-label="Dismiss split rules"
        data-tooltip=""
        data-testid="split-rules-backdrop"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="split-rules-title"
        data-testid="split-rules"
        className="relative flex h-full w-full max-w-[1024px] flex-col overflow-hidden bg-ground"
      >
        <header className="mb-7 flex flex-none items-start gap-5">
          <div>
            <h2 id="split-rules-title" className="text-[21px] font-medium tracking-tight text-ink">
              Split rules
            </h2>
            <p className="mt-6 text-xs text-ink-dim">
              For {props.accountEmail ?? 'this account'}. A conversation appears in the first matching split.
              Other always stays last.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close split rules"
            onClick={onClose}
            className="ml-auto flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-dim hover:bg-active"
          >
            Close <Kbd>Esc</Kbd>
          </button>
        </header>

        <SmartSplitsCard
          status={triageStatus}
          keyPreview={aiSettings?.triageKeyPreview ?? null}
          model={aiSettings?.triageModel ?? null}
          onChanged={reloadTriage}
        />

        <div className="flex min-h-0 flex-1">
          <div className="app-navigation-focus min-h-0 w-56 shrink-0 overflow-y-auto border-r border-edge/60 pr-6 max-md:w-44 max-md:pr-3">
            <div className="mb-3 flex justify-between px-3 text-[10px] text-ink-dim">
              <span>Match order</span>
              <span>Unread</span>
            </div>
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
                      triageUsable={triageUsable}
                      onNotify={(notify) => void run(() => onNotify(split.id, notify))}
                      selected={draft ? draft.id === split.id : builtInId === split.id}
                      onEdit={() => {
                        if (split.id === IMPORTANT_SPLIT_ID) {
                          setDraft(null)
                          setBuiltInId(split.id)
                        } else {
                          setModeConfirm(null)
                          setDraft(draftFor(split))
                        }
                      }}
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
                    triageUsable={triageUsable}
                    onNotify={(notify) => void run(() => onNotify(fallbackSplit.id, notify))}
                    selected={!draft && builtInId === OTHER_SPLIT_ID}
                    onEdit={() => {
                      setDraft(null)
                      setBuiltInId(OTHER_SPLIT_ID)
                    }}
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
                    triageUsable={triageUsable}
                    isOverlay={true}
                    onNotify={noop}
                    onEdit={noop}
                    onDelete={noop}
                    onMove={noop}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="split-rule-new"
                onClick={() => {
                  setModeConfirm(null)
                  setDraft(draftFor(undefined, triageUsableRef.current))
                }}
                className="h-9 cursor-pointer rounded-md px-2 text-xs text-accent"
              >
                ＋ New split
              </button>
              {state.restorablePresetIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  data-testid="split-rule-restore"
                  disabled={busy}
                  onClick={() => void run(() => onRestore(id))}
                  className="h-9 cursor-pointer rounded-md px-2 text-xs text-ink-dim hover:bg-active hover:text-ink"
                >
                  Restore {PRESET_NAMES[id]}
                </button>
              ))}
            </div>
            <p
              id="split-reorder-help"
              className="mt-4 border-t border-edge px-3 pt-[18px] text-[11px] leading-[1.7] text-ink-dim"
            >
              First match wins.
              <br />
              Drag a handle to change the order. Other stays at the end.
              <span className="sr-only">With a handle focused, use the Up and Down arrow keys.</span>
            </p>
            {error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {error}
              </p>
            )}
          </div>

          {draft ? (
            <form
              data-testid="split-rule-editor"
              className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pl-[33px] pr-4 pt-2 max-md:pl-4"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  await onSave(
                    draft.mode === 'description'
                      ? {
                          id: draft.id,
                          name: draft.name,
                          notify: draft.notify,
                          mode: 'description',
                          description: draft.description
                        }
                      : {
                          id: draft.id,
                          name: draft.name,
                          notify: draft.notify,
                          mode: 'rules',
                          operator: draft.operator,
                          conditions: draft.conditions.map(({ condition }) => condition)
                        }
                  )
                  setDraft(null)
                })
              }}
            >
              <p className="mb-4 text-[11px] text-ink-dim">Current account · {props.accountEmail}</p>
              <h3 className="mb-[22px] text-[17px] font-medium text-ink">{draft.name || 'New split'}</h3>
              <label className="block text-[11px] text-ink-dim">
                Split name
                <input
                  ref={nameInputRef}
                  data-testid="split-rule-name"
                  value={draft.name}
                  maxLength={64}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  className="mt-1.5 h-9 w-full rounded-md border border-edge bg-ground px-3 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <fieldset
                data-testid="split-rule-mode"
                className="mt-[25px] inline-flex w-fit gap-1 rounded-md border border-edge p-1"
              >
                <legend className="sr-only">How this split matches</legend>
                <button
                  type="button"
                  data-testid="split-rule-mode-description"
                  aria-pressed={draft.mode === 'description'}
                  disabled={!triageUsable}
                  title={triageUsable ? undefined : 'Turn on smart splits to describe a split'}
                  onClick={() => requestMode('description')}
                  className={MODE_BUTTON(draft.mode === 'description')}
                >
                  Describe it
                </button>
                <button
                  type="button"
                  data-testid="split-rule-mode-rules"
                  aria-pressed={draft.mode === 'rules'}
                  onClick={() => requestMode('rules')}
                  className={MODE_BUTTON(draft.mode === 'rules')}
                >
                  Match by rules
                </button>
              </fieldset>
              {modeConfirm && (
                <div
                  data-testid="split-rule-mode-confirm"
                  className="mt-2.5 flex flex-wrap items-center gap-2.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2"
                >
                  <span className="text-[11px] leading-[1.65] text-ink-dim">
                    {modeConfirm === 'rules' ? 'Discard the description?' : 'Discard the rules?'}
                  </span>
                  <button
                    type="button"
                    data-testid="split-rule-mode-confirm-apply"
                    onClick={() => applyMode(modeConfirm)}
                    className="cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    data-testid="split-rule-mode-confirm-cancel"
                    onClick={() => setModeConfirm(null)}
                    className="cursor-pointer rounded-md border border-edge px-2.5 py-1 text-[11px] text-ink-dim hover:bg-active hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {draft.mode === 'description' ? (
                <div className="mt-[25px] mb-6 flex flex-col gap-1.5">
                  <textarea
                    data-testid="split-rule-description"
                    aria-label="Split description"
                    rows={4}
                    maxLength={SPLIT_DESCRIPTION_MAX_LENGTH}
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="Anything from my landlord"
                    className="w-full max-w-[520px] resize-none rounded-md border border-edge bg-ground px-3 py-2 text-[11px] leading-[1.5] text-ink outline-none focus:border-accent"
                  />
                  <span className="max-w-[520px] text-[11px] leading-[1.65] text-ink-dim">
                    Describe what belongs here, and give an example. The classifier reads the words literally,
                    so avoid ‘not …’.
                  </span>
                </div>
              ) : (
                <>
                  <div className="mt-[25px] mb-[19px] flex items-center gap-2.5">
                    <label className="text-xs text-ink" htmlFor="split-operator">
                      Match
                    </label>
                    <select
                      id="split-operator"
                      data-testid="split-rule-operator"
                      value={draft.operator}
                      onChange={(event) =>
                        setDraft({ ...draft, operator: event.target.value === 'all' ? 'all' : 'any' })
                      }
                      className="h-8 rounded-md border border-edge bg-ground px-2 text-xs text-ink"
                    >
                      <option value="any">any</option>
                      <option value="all">all</option>
                    </select>
                    <span className="text-xs text-ink">of these conditions</span>
                  </div>
                  <div className="flex flex-col gap-[11px]">
                    {draft.conditions.map(({ key, condition }, index) => (
                      <div
                        key={key}
                        data-testid="split-rule-condition"
                        className="grid grid-cols-[145px_minmax(0,1fr)_24px] items-center gap-2.5"
                      >
                        <select
                          aria-label={`Condition ${index + 1} type`}
                          value={condition.type}
                          onChange={(event) => {
                            const type = event.target.value as SplitCondition['type']
                            const next: SplitCondition =
                              type === 'listIdPresent' ? { type } : { type, value: '' }
                            const conditions = [...draft.conditions]
                            conditions[index] = { key, condition: next }
                            setDraft({ ...draft, conditions })
                          }}
                          className="h-9 w-full rounded-md border border-edge bg-ground px-2 text-xs text-ink"
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
                            className="h-9 min-w-0 flex-1 rounded-md border border-edge bg-ground px-3 text-[11px] text-ink outline-none focus:border-accent"
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
                              conditions: draft.conditions.filter(
                                (_, conditionIndex) => conditionIndex !== index
                              )
                            })
                          }
                          className="h-9 w-full cursor-pointer rounded-md text-ink-faint hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-30"
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
                    className="mt-3 mb-6 cursor-pointer text-[11px] text-accent hover:underline"
                  >
                    ＋ Add condition
                  </button>
                </>
              )}
              <p className="mb-[27px] text-[11px] leading-[1.65] text-ink-dim">
                {draft.mode === 'description'
                  ? 'TypeSafe judges each Inbox conversation against your words.'
                  : draft.operator === 'all'
                    ? 'The same message must satisfy every condition.'
                    : 'A thread matches when a message satisfies any condition.'}{' '}
                Splits organize your view; they do not move mail.
              </p>
              <label className="flex items-center justify-between border-t border-edge pt-[23px] text-xs text-ink">
                <span>
                  Notify for this split
                  <span className="mt-[7px] block text-[11px] text-ink-dim">
                    Show a desktop alert for new matching mail.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="app-pref-toggle"
                  checked={draft.notify}
                  onChange={(event) => setDraft({ ...draft, notify: event.target.checked })}
                />
              </label>
              {error && (
                <p role="alert" className="mt-3 text-xs text-danger">
                  {error}
                </p>
              )}
              <footer className="mt-[35px] flex items-center gap-[19px]">
                {draft.id && (
                  <button
                    type="button"
                    data-testid="split-rule-delete"
                    disabled={busy}
                    className="order-2 ml-auto rounded-md px-2 py-2 text-[11px] text-ink-dim hover:bg-active"
                    onClick={() => {
                      const id = draft.id
                      if (id)
                        void run(() => onDelete(id)).then((saved) => {
                          if (saved) setDraft(null)
                        })
                    }}
                  >
                    Delete split
                  </button>
                )}
                <button
                  type="submit"
                  data-testid="split-rule-save"
                  disabled={busy}
                  className="h-9 cursor-pointer rounded-md bg-accent px-4 text-xs text-on-accent disabled:opacity-50"
                >
                  Save changes
                </button>
              </footer>
              <p className="mt-[25px] border-t border-edge pt-[17px] text-[11px] text-ink-dim">
                Changes apply to this account’s Inbox.
              </p>
            </form>
          ) : (
            <div className="min-w-0 flex-1 overflow-y-auto pl-[33px] pr-4 pt-2">
              <p className="mb-4 text-[11px] text-ink-dim">Current account · {props.accountEmail}</p>
              <h3 className="mb-[22px] text-[17px] font-medium text-ink">
                {builtIn?.name ?? 'Select a split'}
              </h3>
              <p className="text-xs leading-6 text-ink-dim">
                {builtInId === OTHER_SPLIT_ID
                  ? 'Other contains Inbox mail that does not match an earlier split. It always stays last.'
                  : 'Important uses Gmail’s Important label. Its matching rule cannot be edited.'}
              </p>
              {builtIn && (
                <label className="mt-8 flex items-center justify-between border-t border-edge/50 pt-5 text-xs text-ink">
                  <span>
                    Notify for this split
                    <span className="mt-[7px] block text-[11px] text-ink-dim">
                      Show a desktop alert for new matching mail.
                    </span>
                  </span>
                  <input
                    data-testid="split-rule-notify"
                    type="checkbox"
                    checked={builtIn.notify}
                    disabled={busy}
                    className="app-pref-toggle"
                    onChange={(event) => void run(() => onNotify(builtIn.id, event.target.checked))}
                  />
                </label>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
