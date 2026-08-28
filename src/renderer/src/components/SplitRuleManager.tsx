import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  IMPORTANT_SPLIT_ID,
  OTHER_SPLIT_ID,
  type SaveSplitInput,
  type SplitCondition,
  type SplitPresetId,
  type SplitRule,
  type SplitState
} from '../../../shared/splits'

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

interface DropTarget {
  id: string
  after: boolean
}

let nextConditionKey = 0

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

export function SplitRuleManager(props: SplitRuleManagerProps): React.JSX.Element {
  const { state, onSave, onNotify, onDelete, onReorder, onRestore, onClose } = props
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const matchingSplits = useMemo(
    () => state.splits.filter((split) => split.id !== OTHER_SPLIT_ID),
    [state.splits]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (draft) setDraft(null)
      else onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, onClose])

  useEffect(() => {
    if (draft) nameInputRef.current?.focus()
  }, [draft])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update splits')
    } finally {
      setBusy(false)
    }
  }

  const move = (id: string, direction: -1 | 1): void => {
    const ids = matchingSplits.map((split) => split.id)
    const index = ids.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void run(() => onReorder(ids))
  }

  const drop = (id: string, targetId: string, after: boolean): void => {
    const currentIds = matchingSplits.map((split) => split.id)
    if (!currentIds.includes(id)) return
    const ids = currentIds.filter((candidate) => candidate !== id)
    const targetIndex = targetId === OTHER_SPLIT_ID ? ids.length : ids.indexOf(targetId)
    if (targetIndex < 0) return
    ids.splice(targetIndex + (targetId === OTHER_SPLIT_ID || !after ? 0 : 1), 0, id)
    if (ids.every((candidate, index) => candidate === currentIds[index])) return
    void run(() => onReorder(ids))
  }

  const dragOver = (event: DragEvent<HTMLLIElement>, splitId: string, fallback: boolean): void => {
    if (!draggingId || draggingId === splitId || busy) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    setDropTarget({
      id: splitId,
      after: !fallback && event.clientY >= bounds.top + bounds.height / 2
    })
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
        className="relative flex max-h-[min(720px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-dialog"
      >
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
            className="ml-auto size-8 cursor-pointer rounded-md text-xl text-ink-faint hover:bg-active hover:text-ink"
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
                className="mt-1.5 h-9 w-full rounded-md border border-edge bg-ground px-3 text-sm text-ink outline-none focus:border-accent"
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
                className="h-8 rounded-md border border-edge bg-ground px-2 text-xs text-ink"
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
                    className="h-9 w-52 rounded-md border border-edge bg-ground px-2 text-xs text-ink"
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
                      className="h-9 min-w-0 flex-1 rounded-md border border-edge bg-ground px-3 text-sm text-ink outline-none focus:border-accent"
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
                    className="size-9 cursor-pointer rounded-md text-ink-faint hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-30"
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
            <p className="mt-4 rounded-md border border-edge bg-ground/60 p-3 text-[11px] leading-5 text-ink-faint">
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
                className="h-9 cursor-pointer rounded-md px-4 text-xs font-semibold text-ink-dim hover:bg-active"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="h-9 cursor-pointer rounded-md bg-accent px-4 text-xs font-semibold text-ground disabled:opacity-50"
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
            <ol className="flex flex-col gap-2">
              {state.splits.map((split, index) => {
                const fallback = split.id === OTHER_SPLIT_ID
                const readOnlyMatch = split.id === IMPORTANT_SPLIT_ID || fallback
                const matchingIndex = matchingSplits.findIndex((candidate) => candidate.id === split.id)
                return (
                  <li
                    key={split.id}
                    data-testid="split-rule"
                    data-split-id={split.id}
                    data-dragging={draggingId === split.id ? 'true' : 'false'}
                    onDragOver={(event) => dragOver(event, split.id, fallback)}
                    onDrop={(event) => {
                      event.preventDefault()
                      const id = draggingId ?? event.dataTransfer.getData('text/plain')
                      const bounds = event.currentTarget.getBoundingClientRect()
                      const after = !fallback && event.clientY >= bounds.top + bounds.height / 2
                      setDraggingId(null)
                      setDropTarget(null)
                      if (id) drop(id, split.id, after)
                    }}
                    className={`relative grid min-h-[72px] grid-cols-[minmax(0,1fr)_96px_36px_112px] items-center gap-3 rounded-lg border bg-ground/45 px-3 transition-[border-color,opacity] ${
                      draggingId === split.id ? 'opacity-45' : 'opacity-100'
                    } ${dropTarget?.id === split.id ? 'border-accent' : 'border-edge'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{split.name}</span>
                        <span className="text-[10px] tabular-nums text-ink-faint">
                          {split.total.toLocaleString()} total · {split.unread.toLocaleString()} unread
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
                        onChange={(event) => void run(() => onNotify(split.id, event.target.checked))}
                      />
                      Notify
                    </label>
                    {!fallback ? (
                      <button
                        type="button"
                        draggable={!busy}
                        data-testid="split-rule-drag-handle"
                        aria-label={`Reorder ${split.name}`}
                        aria-describedby="split-reorder-help"
                        disabled={busy}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', split.id)
                          setDraggingId(split.id)
                          setDropTarget(null)
                        }}
                        onDragEnd={() => {
                          setDraggingId(null)
                          setDropTarget(null)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' && matchingIndex > 0) {
                            event.preventDefault()
                            move(split.id, -1)
                          } else if (event.key === 'ArrowDown' && matchingIndex < matchingSplits.length - 1) {
                            event.preventDefault()
                            move(split.id, 1)
                          }
                        }}
                        className="flex size-8 cursor-grab items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
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
                    {readOnlyMatch ? (
                      <span
                        data-testid="split-rule-action"
                        className="w-28 text-right text-[10px] text-ink-faint"
                      >
                        {fallback ? 'Always last' : 'Built in'}
                      </span>
                    ) : (
                      <div
                        data-testid="split-rule-action"
                        className="flex w-28 items-center justify-end gap-1"
                      >
                        <button
                          type="button"
                          onClick={() => setDraft(draftFor(split))}
                          className="h-8 cursor-pointer rounded-md px-2 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid="split-rule-delete"
                          aria-label={`Delete ${split.name}`}
                          disabled={busy}
                          onClick={() => void run(() => onDelete(split.id))}
                          className="size-8 cursor-pointer rounded-md text-ink-faint hover:bg-danger hover:text-on-danger"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <span className="sr-only">Position {index + 1}</span>
                  </li>
                )
              })}
            </ol>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4">
              <button
                type="button"
                onClick={() => setDraft(draftFor())}
                className="h-9 cursor-pointer rounded-md bg-accent px-4 text-xs font-semibold text-ground"
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
                  className="h-9 cursor-pointer rounded-md border border-edge px-3 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
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
