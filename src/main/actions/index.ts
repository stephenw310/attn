import type { RevertedActionKind } from '../../shared/actionRevert'
import type { ActionQueueStatus, TriageAction, TriageResult } from '../../shared/actions'
import { stringArray } from '../../shared/guards'
import type { Db } from '../db'
import { applyThreadDelta } from '../store/mutate'
import { type SnoozeReminderSnapshot, snoozeReminderSnapshot } from '../store/reminders'
import { isStoredAuthActionError } from './execute'
import { actionLabel, inverseForThread, planAction } from './plan'
import { dropRevertedUndoEntries, type QueuedActionRef, queueIntentRef } from './revert'

type UndoAction = TriageAction | { kind: 'snoozeAt'; threadIds: string[]; dueAt: number }

interface TriageUndoEntry {
  kind: 'triage'
  label: string
  labelFor: (threadCount: number) => string
  undo: UndoAction[]
  refs: QueuedActionRef[]
}

interface OutboxUndoEntry {
  kind: 'outbox-send'
  outboxId: string
}

type UndoEntry = TriageUndoEntry | OutboxUndoEntry

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

interface ApplyResult {
  undo: UndoAction[]
  refs: QueuedActionRef[]
}

function apply(
  db: Db,
  accountId: string,
  action: TriageAction,
  actionKind = noticeKindForAction(action)
): ApplyResult {
  const plan = planAction(action)
  const labelsBefore = new Map(
    action.threadIds.map((threadId) => [threadId, labelsFor(db, accountId, threadId)] as const)
  )
  const remindersBefore = new Map(
    action.threadIds.map((threadId) => [threadId, snoozeReminderSnapshot(db, accountId, threadId)] as const)
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
  const refs: QueuedActionRef[] = []
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
        const reminderBefore = recoveryReminderForAction(action, remindersBefore.get(threadId) ?? null)
        const queued = enqueue.run(
          accountId,
          plan.queueKind,
          threadId,
          JSON.stringify({ add: plan.add, remove: plan.remove, actionKind, reminderBefore })
        )
        const queueId = Number(queued.lastInsertRowid)
        refs.push(
          plan.queueKind === 'modifyLabels'
            ? queueIntentRef(
                {
                  kind: plan.queueKind,
                  threadId,
                  add: plan.add,
                  remove: plan.remove
                },
                queueId
              )
            : queueIntentRef({ kind: plan.queueKind, threadId }, queueId)
        )
      }
    }
  })()
  return { undo, refs }
}

function applySnooze(
  db: Db,
  accountId: string,
  threadIds: string[],
  dueAt: number,
  actionKind: RevertedActionKind = 'snooze'
): QueuedActionRef[] {
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
  const refs: QueuedActionRef[] = []

  for (const threadId of threadIds) {
    const wasInInbox = labelsFor(db, accountId, threadId).has('INBOX')
    const reminderBefore = snoozeReminderSnapshot(db, accountId, threadId)
    upsertReminder.run(accountId, threadId, dueAt)
    applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
    // v1 snooze is local-only by decision (SPEC §9 #6): Gmail sees a plain
    // archive. Gmail-side labels + exact-time return arrive with the v1.5
    // companion script (SPEC F7).
    if (wasInInbox) {
      const queued = enqueue.run(
        accountId,
        threadId,
        JSON.stringify({ add: [], remove: ['INBOX'], actionKind, reminderBefore })
      )
      refs.push(
        queueIntentRef(
          { kind: 'modifyLabels', threadId, add: [], remove: ['INBOX'] },
          Number(queued.lastInsertRowid)
        )
      )
    }
  }
  return refs
}

export function snoozeThreads(db: Db, accountId: string, threadIds: string[], dueAt: number): TriageResult {
  const undo = threadIds.map((threadId): UndoAction => {
    const previous = pendingSnoozeFor(db, accountId, threadId)
    return previous
      ? { kind: 'snoozeAt', threadIds: [threadId], dueAt: previous.dueAt }
      : { kind: 'unsnooze', threadIds: [threadId] }
  })
  const refs = db.transaction(() => applySnooze(db, accountId, threadIds, dueAt))()

  const labelFor = (count: number): string => (count === 1 ? 'Snoozed' : `${count} snoozed`)
  const label = labelFor(threadIds.length)
  const undoStack = undoStackFor(accountId)
  undoStack.push({
    kind: 'triage',
    label,
    labelFor,
    undo,
    refs
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
  const { undo, refs } = apply(db, accountId, action)
  if (recordUndo) {
    const undoStack = undoStackFor(accountId)
    undoStack.push({
      kind: 'triage',
      label,
      labelFor: (count) => actionLabel(action, count),
      undo,
      refs
    })
    if (undoStack.length > 50) undoStack.shift()
  }
  return { label }
}

export function undoLast(db: Db, accountId: string): TriageResult | null {
  const entry = undoStackFor(accountId).pop()
  if (!entry) return null
  if (entry.kind === 'outbox-send') {
    const undone = db
      .prepare(
        `UPDATE outbox SET state = 'composing', send_at = NULL, attempts = 0, verify_attempts = 0,
         last_error = NULL, updated_at = ? WHERE account_id = ? AND id = ? AND state = 'queued'`
      )
      .run(Date.now(), accountId, entry.outboxId).changes
    return undone ? { label: 'Send undone', reopenDraftId: entry.outboxId } : { label: 'Already sent' }
  }
  db.transaction(() => {
    for (const action of entry.undo) {
      if (action.kind === 'snoozeAt') applySnooze(db, accountId, action.threadIds, action.dueAt, 'undo')
      else apply(db, accountId, action, 'undo')
    }
  })()
  return { label: `Undid ${entry.label.toLowerCase()}` }
}

export function recordOutboxSendUndo(accountId: string, outboxId: string): void {
  const stack = undoStackFor(accountId)
  stack.push({ kind: 'outbox-send', outboxId })
  if (stack.length > 50) stack.shift()
}

export function dropOutboxSendUndo(accountId: string, outboxId: string): void {
  const stack = undoStackFor(accountId)
  let index = -1
  for (let candidate = stack.length - 1; candidate >= 0; candidate--) {
    const entry = stack[candidate]
    if (entry.kind === 'outbox-send' && entry.outboxId === outboxId) {
      index = candidate
      break
    }
  }
  if (index >= 0) stack.splice(index, 1)
}

export function clearUndo(accountId?: string): void {
  if (accountId) undoStacks.delete(accountId)
  else undoStacks.clear()
}

export function invalidateRevertedUndo(accountId: string, refs: readonly QueuedActionRef[]): void {
  const stack = undoStacks.get(accountId)
  if (!stack) return
  const next: UndoEntry[] = []
  for (const entry of stack) {
    if (entry.kind === 'triage') next.push(...dropRevertedUndoEntries([entry], refs))
    else next.push(entry)
  }
  undoStacks.set(accountId, next)
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

export function pendingActionCount(db: Db, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM action_queue
       WHERE account_id = ? AND state IN ('pending', 'inflight', 'recovering', 'failed')`
    )
    .get(accountId) as { count: number }
  return row.count
}

export function actionQueueStatus(db: Db, accountId: string): ActionQueueStatus {
  // Only a failed row carries last_error, so this scan stays tiny even when the
  // queue is deep — the common case matches no rows at all.
  const failed = db
    .prepare(
      `SELECT last_error FROM action_queue
       WHERE account_id = ? AND state IN ('pending', 'inflight', 'recovering', 'failed')
         AND last_error IS NOT NULL`
    )
    .all(accountId) as { last_error: string | null }[]
  const paused = failed.filter((row) => isStoredAuthActionError(row.last_error)).length
  return {
    pending: pendingActionCount(db, accountId),
    paused,
    authPaused: paused > 0
  }
}

function recoveryReminderForAction(
  action: TriageAction,
  reminder: SnoozeReminderSnapshot | null
): SnoozeReminderSnapshot | null | undefined {
  if (action.kind === 'unsnooze') return reminder
  if (action.kind === 'archive' && (reminder?.state === 'pending' || reminder?.state === 'returned')) {
    return reminder
  }
  return reminder?.state === 'returned' ? reminder : undefined
}

function noticeKindForAction(action: TriageAction): RevertedActionKind {
  switch (action.kind) {
    case 'restoreInbox':
    case 'untrash':
    case 'unsnooze':
    case 'archive':
    case 'trash':
    case 'spam':
      return action.kind
    case 'star':
      return action.on ? 'star' : 'unstar'
    case 'markUnread':
      return action.on ? 'markUnread' : 'markRead'
    case 'label':
      return 'labels'
  }
}
