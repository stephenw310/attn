import type { TriageAction, TriageResult } from '../../shared/actions'
import type { Db } from '../db'
import { applyThreadDelta } from '../store/mutate'
import { actionLabel, inverseForThread, planAction } from './plan'

interface UndoEntry {
  label: string
  undo: TriageAction[]
}
const undoStack: UndoEntry[] = []

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

export function performTriage(db: Db, accountId: string, action: TriageAction): TriageResult {
  const label = actionLabel(action)
  const undo = apply(db, accountId, action)
  undoStack.push({ label, undo })
  if (undoStack.length > 50) undoStack.shift()
  return { label }
}

export function undoLast(db: Db, accountId: string): TriageResult | null {
  const entry = undoStack.pop()
  if (!entry) return null
  db.transaction(() => {
    for (const action of entry.undo) apply(db, accountId, action)
  })()
  return { label: `Undid ${entry.label.toLowerCase()}` }
}

export function pendingActionCount(db: Db, accountId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM action_queue WHERE account_id = ? AND state != 'failed'")
    .get(accountId) as { count: number }
  return row.count
}
