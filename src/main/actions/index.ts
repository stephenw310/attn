import type { TriageAction, TriageResult } from '../../shared/actions'
import type { Db } from '../db'
import { applyThreadDelta } from '../store/mutate'
import { actionLabel, inverseForThread, planAction } from './plan'

type UndoAction = TriageAction | { kind: 'snoozeAt'; threadIds: string[]; dueAt: number }

interface UndoEntry {
  label: string
  undo: UndoAction[]
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

function pendingSnoozeFor(db: Db, accountId: string, threadId: string): { dueAt: number } | undefined {
  return db
    .prepare(
      `SELECT due_at AS dueAt FROM reminders
       WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'pending'`
    )
    .get(accountId, threadId) as { dueAt: number } | undefined
}

function apply(db: Db, accountId: string, action: TriageAction): UndoAction[] {
  const plan = planAction(action)
  const labelsBefore = new Map(
    action.threadIds.map((threadId) => [threadId, labelsFor(db, accountId, threadId)] as const)
  )
  const undo = action.threadIds.map((id): UndoAction => {
    if (action.kind === 'unsnooze' || action.kind === 'archive') {
      const reminder = pendingSnoozeFor(db, accountId, id)
      if (reminder) return { kind: 'snoozeAt', threadIds: [id], dueAt: reminder.dueAt }
    }
    return inverseForThread(action, labelsBefore.get(id) ?? new Set(), id)
  })
  const enqueue = db.prepare(
    `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
     VALUES (?, ?, ?, ?, 'pending')`
  )
  db.transaction(() => {
    for (const threadId of action.threadIds) {
      if (action.kind === 'unsnooze') {
        db.prepare("DELETE FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'snooze'").run(
          accountId,
          threadId
        )
      } else if (action.kind === 'archive') {
        db.prepare(
          `UPDATE reminders SET state = CASE state WHEN 'pending' THEN 'canceled' ELSE 'done' END
           WHERE account_id = ? AND thread_id = ? AND kind = 'snooze'
             AND state IN ('pending', 'returned')`
        ).run(accountId, threadId)
      } else {
        db.prepare(
          `UPDATE reminders SET state = 'done'
           WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'returned'`
        ).run(accountId, threadId)
      }
      applyThreadDelta(db, accountId, { threadId, add: plan.add, remove: plan.remove })
      const archiveWasAlreadyApplied = action.kind === 'archive' && !labelsBefore.get(threadId)?.has('INBOX')
      if (!archiveWasAlreadyApplied) {
        enqueue.run(
          accountId,
          plan.queueKind,
          threadId,
          JSON.stringify({ add: plan.add, remove: plan.remove })
        )
      }
    }
  })()
  return undo
}

function applySnooze(db: Db, accountId: string, threadIds: string[], dueAt: number): void {
  const upsertReminder = db.prepare(
    `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
     VALUES (?, ?, 'snooze', ?, 'pending')
     ON CONFLICT(account_id, thread_id, kind) DO UPDATE SET
       due_at = excluded.due_at, state = 'pending'`
  )
  const enqueue = db.prepare(
    `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
     VALUES (?, 'modifyLabels', ?, ?, 'pending')`
  )

  for (const threadId of threadIds) {
    const wasInInbox = labelsFor(db, accountId, threadId).has('INBOX')
    upsertReminder.run(accountId, threadId, dueAt)
    applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
    // v1 snooze is local-only by decision (SPEC §9 #6): Gmail sees a plain
    // archive. Gmail-side labels + exact-time return arrive with the v1.5
    // companion script (SPEC F7).
    if (wasInInbox) {
      enqueue.run(accountId, threadId, JSON.stringify({ add: [], remove: ['INBOX'] }))
    }
  }
}

export function snoozeThreads(db: Db, accountId: string, threadIds: string[], dueAt: number): TriageResult {
  const undo = threadIds.map((threadId): UndoAction => {
    const previous = pendingSnoozeFor(db, accountId, threadId)
    return previous
      ? { kind: 'snoozeAt', threadIds: [threadId], dueAt: previous.dueAt }
      : { kind: 'unsnooze', threadIds: [threadId] }
  })
  db.transaction(() => applySnooze(db, accountId, threadIds, dueAt))()

  const label = threadIds.length === 1 ? 'Snoozed' : `${threadIds.length} snoozed`
  const undoStack = undoStackFor(accountId)
  undoStack.push({
    label,
    undo
  })
  if (undoStack.length > 50) undoStack.shift()
  return { label }
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
    for (const action of entry.undo) {
      if (action.kind === 'snoozeAt') applySnooze(db, accountId, action.threadIds, action.dueAt)
      else apply(db, accountId, action)
    }
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
    case 'unsnooze':
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

// Deliberately counts 'failed' rows: an action that never reached Gmail must not
// silently vanish from the badge. M2 removes the need — permanently failed triage
// actions will self-heal to server truth instead of lingering (M2-PLAN T18).
export function pendingActionCount(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM action_queue WHERE account_id = ?')
    .get(accountId) as { count: number }
  return row.count
}
