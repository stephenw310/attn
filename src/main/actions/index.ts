import type { TriageAction, TriageResult } from '../../shared/actions'
import type { Db } from '../db'
import { applyThreadDelta } from '../store/mutate'
import { actionLabel, inverseForThread, planAction } from './plan'

interface UndoEntry {
  label: string
  undo: TriageAction[]
}
const undoStacks = new Map<string, UndoEntry[]>()

function undoStackFor(accountId: string): UndoEntry[] {
  const existing = undoStacks.get(accountId)
  if (existing) return existing
  const created: UndoEntry[] = []
  undoStacks.set(accountId, created)
  return created
}

function labelsFor(db: Db, accountId: string, threadId: string): Set<string> {
  const rows = db
    .prepare('SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ?')
    .all(accountId, threadId) as { label_id: string }[]
  return new Set(rows.map((row) => row.label_id))
}

function apply(db: Db, accountId: string, action: TriageAction): TriageAction[] {
  const plan = planAction(action)
  const undo = action.threadIds.map((id) => inverseForThread(action, labelsFor(db, accountId, id), id))
  const enqueue = db.prepare(
    `INSERT INTO action_queue (account_id, kind, thread_id, payload, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  )
  db.transaction(() => {
    for (const threadId of action.threadIds) {
      applyThreadDelta(db, accountId, { threadId, add: plan.add, remove: plan.remove })
      enqueue.run(
        accountId,
        plan.queueKind,
        threadId,
        JSON.stringify({ add: plan.add, remove: plan.remove }),
        Date.now()
      )
    }
  })()
  return undo
}

export function performTriage(
  db: Db,
  accountId: string,
  action: TriageAction,
  recordUndo = true
): TriageResult {
  const label = actionLabel(action)
  const undo = apply(db, accountId, action)
  if (recordUndo) {
    const undoStack = undoStackFor(accountId)
    undoStack.push({ label, undo })
    if (undoStack.length > 50) undoStack.shift()
  }
  return { label }
}

export function undoLast(db: Db, accountId: string): TriageResult | null {
  const entry = undoStackFor(accountId).pop()
  if (!entry) return null
  db.transaction(() => {
    for (const action of entry.undo) apply(db, accountId, action)
  })()
  return { label: `Undid ${entry.label.toLowerCase()}` }
}

export function clearUndo(accountId?: string): void {
  if (accountId) undoStacks.delete(accountId)
  else undoStacks.clear()
}

export function isTriageAction(value: unknown): value is TriageAction {
  if (!value || typeof value !== 'object') return false
  const action = value as Record<string, unknown>
  const threadIds = action.threadIds
  if (
    !Array.isArray(threadIds) ||
    threadIds.length === 0 ||
    !threadIds.every((id) => typeof id === 'string')
  ) {
    return false
  }
  switch (action.kind) {
    case 'archive':
    case 'trash':
    case 'spam':
    case 'restoreInbox':
    case 'untrash':
      return true
    case 'star':
    case 'markUnread':
      return typeof action.on === 'boolean'
    case 'label':
      return stringArray(action.add) && stringArray(action.remove)
    default:
      return false
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function pendingActionCount(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM action_queue WHERE account_id = ?')
    .get(accountId) as { count: number }
  return row.count
}
