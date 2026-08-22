import type { TriageAction } from '../../shared/actions'

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
