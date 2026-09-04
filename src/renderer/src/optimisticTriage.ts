import type { TriageAction } from '../../shared/actions'
import { moveLabelDelta } from '../../shared/move'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../shared/splits'
import { type MailView, userLabelId } from './list/mailDisplay'

type ThreadFlag = 'starred' | 'unread'

export interface ThreadFlagSnapshot {
  field: ThreadFlag
  on: boolean
  before: ReadonlyMap<string, boolean>
}

interface ThreadFlags {
  id: string
  starred: boolean
  unread: boolean
}

export interface ThreadMoveFields {
  id: string
  labelIds: readonly string[]
  snoozed: boolean
  returned: boolean
}

interface ThreadMoveState {
  labelIds: readonly string[]
  snoozed: boolean
  returned: boolean
}

export interface ThreadMoveSnapshot {
  before: ReadonlyMap<string, ThreadMoveState>
  add: readonly string[]
  remove: readonly string[]
}

export interface ExitSelection {
  fromId: string
  toId: string | null
  nextIndex: number
}

export function threadFlagSnapshot(
  action: TriageAction,
  threads: readonly ThreadFlags[]
): ThreadFlagSnapshot | null {
  if (action.kind !== 'star' && action.kind !== 'markUnread') return null
  const field = action.kind === 'star' ? 'starred' : 'unread'
  const targetedIds = new Set(action.threadIds)
  return {
    field,
    on: action.on,
    before: new Map(
      threads
        .filter((thread) => targetedIds.has(thread.id))
        .map((thread) => [thread.id, thread[field]] as const)
    )
  }
}

export function applyThreadFlag<T extends ThreadFlags>(
  rows: T[] | null,
  snapshot: ThreadFlagSnapshot
): T[] | null {
  if (!rows) return rows
  let changed = false
  const next = rows.map((row) => {
    if (!snapshot.before.has(row.id) || row[snapshot.field] === snapshot.on) return row
    changed = true
    return { ...row, [snapshot.field]: snapshot.on }
  })
  return changed ? next : rows
}

export function rollbackThreadFlag<T extends ThreadFlags>(
  rows: T[] | null,
  snapshot: ThreadFlagSnapshot
): T[] | null {
  if (!rows) return rows
  let changed = false
  const next = rows.map((row) => {
    const before = snapshot.before.get(row.id)
    // Do not overwrite a newer optimistic action on the same thread.
    if (before === undefined || row[snapshot.field] !== snapshot.on || before === snapshot.on) return row
    changed = true
    return { ...row, [snapshot.field]: before }
  })
  return changed ? next : rows
}

export function applyThreadFlagToElement(
  element: HTMLElement | null,
  snapshot: ThreadFlagSnapshot,
  rollback = false
): void {
  if (!element || !snapshot.before.has(element.dataset.threadId ?? '')) return
  const attribute = snapshot.field === 'starred' ? 'starred' : 'unread'
  const value = rollback ? snapshot.before.get(element.dataset.threadId ?? '') : snapshot.on
  if (value) element.dataset[attribute] = 'true'
  else delete element.dataset[attribute]
}

function moveState(
  row: Pick<ThreadMoveFields, 'labelIds' | 'snoozed' | 'returned'>,
  snapshot: ThreadMoveSnapshot
): ThreadMoveState {
  const removed = new Set(snapshot.remove)
  const labels = row.labelIds.filter((labelId) => !removed.has(labelId))
  for (const labelId of snapshot.add) {
    if (!labels.includes(labelId)) labels.push(labelId)
  }
  return { labelIds: labels, snoozed: false, returned: false }
}

function sameMoveState(
  row: Pick<ThreadMoveFields, 'labelIds' | 'snoozed' | 'returned'>,
  state: ThreadMoveState
): boolean {
  return (
    row.snoozed === state.snoozed &&
    row.returned === state.returned &&
    row.labelIds.length === state.labelIds.length &&
    row.labelIds.every((labelId, index) => labelId === state.labelIds[index])
  )
}

export function threadMoveSnapshot(
  action: TriageAction,
  threads: readonly ThreadMoveFields[]
): ThreadMoveSnapshot | null {
  const delta =
    action.kind === 'move'
      ? moveLabelDelta(action.destination, action.sourceLabelId)
      : action.kind === 'spam' || action.kind === 'trash'
        ? moveLabelDelta({ kind: action.kind }, null)
        : null
  if (!delta) return null
  const targetedIds = new Set(action.threadIds)
  return {
    before: new Map(
      threads
        .filter((thread) => targetedIds.has(thread.id))
        .map(
          (thread) =>
            [
              thread.id,
              {
                labelIds: [...thread.labelIds],
                snoozed: thread.snoozed,
                returned: thread.returned
              }
            ] as const
        )
    ),
    add: delta.add,
    remove: delta.remove
  }
}

export function applyThreadMove<T extends ThreadMoveFields>(
  rows: T[] | null,
  snapshot: ThreadMoveSnapshot
): T[] | null {
  if (!rows) return rows
  let changed = false
  const next = rows.map((row) => {
    if (!snapshot.before.has(row.id)) return row
    const after = moveState(row, snapshot)
    if (sameMoveState(row, after)) return row
    changed = true
    return { ...row, ...after }
  })
  return changed ? next : rows
}

export function rollbackThreadMove<T extends ThreadMoveFields>(
  rows: T[] | null,
  snapshot: ThreadMoveSnapshot
): T[] | null {
  if (!rows) return rows
  let changed = false
  const next = rows.map((row) => {
    const before = snapshot.before.get(row.id)
    if (!before) return row
    // Do not overwrite a newer Move or label refresh on the same thread.
    const after = moveState(before, snapshot)
    if (!sameMoveState(row, after) || sameMoveState(row, before)) return row
    changed = true
    return { ...row, labelIds: [...before.labelIds], snoozed: before.snoozed, returned: before.returned }
  })
  return changed ? next : rows
}

export function movedThreadIdsOutsideView<T extends ThreadMoveFields>(
  threads: readonly T[],
  snapshot: ThreadMoveSnapshot,
  retainsThread: (thread: T) => boolean
): string[] {
  const moved = applyThreadMove([...threads], snapshot) ?? []
  return moved
    .filter((thread) => snapshot.before.has(thread.id) && !retainsThread(thread))
    .map((thread) => thread.id)
}

export function applyThreadMoveMembership<T extends ThreadMoveFields>(
  rows: T[] | null,
  snapshot: ThreadMoveSnapshot,
  retainsThread: (thread: T) => boolean,
  preservedIds: ReadonlySet<string> = new Set()
): T[] | null {
  const moved = applyThreadMove(rows, snapshot)
  if (!moved) return moved
  const next = moved.filter(
    (thread) => !snapshot.before.has(thread.id) || preservedIds.has(thread.id) || retainsThread(thread)
  )
  return next.length === moved.length ? moved : next
}

export function rollbackThreadMoveMembership<T extends ThreadMoveFields>(
  rows: T[] | null,
  beforeRows: readonly T[] | null,
  snapshot: ThreadMoveSnapshot
): T[] | null {
  if (!rows || !beforeRows) return rollbackThreadMove(rows, snapshot)
  const currentById = new Map(rows.map((row) => [row.id, row]))
  const restored: T[] = []
  for (const beforeRow of beforeRows) {
    const current = currentById.get(beforeRow.id)
    if (current) {
      restored.push(current)
      currentById.delete(beforeRow.id)
    } else if (snapshot.before.has(beforeRow.id)) {
      restored.push(beforeRow)
    }
  }
  for (const current of currentById.values()) {
    if (!snapshot.before.has(current.id)) restored.push(current)
  }
  return rollbackThreadMove(restored, snapshot)
}

export function moveExitsView(
  action: TriageAction,
  view: MailView,
  activeSplitId: string | null = null
): boolean {
  const destination =
    action.kind === 'move'
      ? action.destination
      : action.kind === 'spam' || action.kind === 'trash'
        ? { kind: action.kind as 'spam' | 'trash' }
        : null
  if (!destination) return false
  const delta = moveLabelDelta(destination, action.kind === 'move' ? action.sourceLabelId : null)
  const add = new Set(delta.add)
  const remove = new Set(delta.remove)
  if (view === 'inbox') {
    if (activeSplitId === IMPORTANT_SPLIT_ID && destination.kind === 'other') return true
    if (activeSplitId === OTHER_SPLIT_ID && destination.kind === 'important') return true
    return remove.has('INBOX') && !add.has('INBOX')
  }
  if (view === 'snoozed') return true
  if (view === 'spam') return remove.has('SPAM') && !add.has('SPAM')
  if (view === 'trash') return remove.has('TRASH') && !add.has('TRASH')
  if (
    (view === 'allMail' || view === 'sent' || view === 'starred') &&
    (add.has('SPAM') || add.has('TRASH'))
  ) {
    return true
  }
  const labelId = userLabelId(view)
  return labelId !== null && action.kind === 'move' && labelId === action.sourceLabelId
}

export function selectionAfterExit(
  threads: readonly { id: string }[],
  targetIds: readonly string[],
  selectedIndex: number,
  direction: 'next' | 'previous' = 'next'
): ExitSelection | null {
  const selectedThread = threads[selectedIndex]
  if (!selectedThread) return null
  const targets = new Set(targetIds)
  // The auto-advance setting decides which surviving neighbour is preferred
  // (F3: next / previous); the opposite side stays the fallback so triaging
  // the first or last row still lands somewhere.
  const scanDown = (from: number): number => {
    let index = from
    while (index < threads.length && targets.has(threads[index].id)) index++
    return index
  }
  const scanUp = (from: number): number => {
    let index = from
    while (index >= 0 && targets.has(threads[index].id)) index--
    return index
  }
  let nextIndex: number
  if (!targets.has(selectedThread.id)) {
    // The focused row survives (a bulk action elsewhere): the selection stays.
    nextIndex = selectedIndex
  } else if (direction === 'previous') {
    nextIndex = scanUp(selectedIndex - 1)
    if (nextIndex < 0) nextIndex = scanDown(selectedIndex)
  } else {
    nextIndex = scanDown(selectedIndex)
    if (nextIndex >= threads.length) nextIndex = scanUp(selectedIndex - 1)
  }
  return {
    fromId: selectedThread.id,
    toId: threads[nextIndex]?.id ?? null,
    nextIndex
  }
}
