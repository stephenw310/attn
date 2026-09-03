import type { RevertedActionKind } from '../../shared/actionRevert'
import type { ActionQueueStatus, TriageAction, TriageResult } from '../../shared/actions'
import { stringArray } from '../../shared/guards'
import { isMoveDestination } from '../../shared/move'
import type { Db } from '../db'
import { evaluateThreadFollowUp } from '../followUps'
import { applyThreadDelta } from '../store/mutate'
import {
  type FollowUpReminderSnapshot,
  followUpReminderSnapshot,
  restoreFollowUpReminder,
  restoreSnoozeReminder,
  type SnoozeReminderSnapshot,
  snoozeReminderSnapshot
} from '../store/reminders'
import { isStoredAuthActionError } from './execute'
import { actionLabel, inverseForThread, planAction } from './plan'
import { dropRevertedUndoEntries, type QueuedActionRef, queueRowRef } from './revert'

interface MoveUndoAction {
  kind: 'moveUndo'
  threadIds: string[]
  add: string[]
  remove: string[]
  reminderBefore: SnoozeReminderSnapshot | null
  reminderAfter: SnoozeReminderSnapshot | null
  followUpBefore: FollowUpReminderSnapshot | null
  followUpAfter: FollowUpReminderSnapshot | null
  revertsQueueId?: number
}

interface FollowUpRestoreAction {
  kind: 'followUpRestore'
  threadIds: string[]
  before: FollowUpReminderSnapshot
  after: FollowUpReminderSnapshot
}

/** A triage inverse, tagged with the queue row it reverts so a rejected forward action can drop it. */
type UndoTriageAction = TriageAction & { revertsQueueId?: number }

interface SnoozeAtUndoAction {
  kind: 'snoozeAt'
  threadIds: string[]
  dueAt: number
}

type UndoAction = UndoTriageAction | MoveUndoAction | FollowUpRestoreAction | SnoozeAtUndoAction

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

function labelsOnEveryMessageFor(
  db: Db,
  accountId: string,
  threadId: string,
  threadLabels: ReadonlySet<string>
): Set<string> {
  const rows = db
    .prepare('SELECT labels_json FROM messages WHERE account_id = ? AND thread_id = ?')
    .all(accountId, threadId) as Array<{ labels_json: string | null }>
  if (rows.length === 0) return new Set(threadLabels)
  let common: Set<string> | null = null
  for (const row of rows) {
    // A manually upgraded legacy row cannot prove per-message membership. A
    // redundant provider add is safer than leaving the destination partial.
    if (row.labels_json === null) return new Set()
    const labels = new Set(JSON.parse(row.labels_json) as string[])
    if (common === null) {
      common = labels
      continue
    }
    for (const label of common) {
      if (!labels.has(label)) common.delete(label)
    }
  }
  return common ?? new Set()
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
  /** Threads this action actually changed — the toast counts these, not the targets. */
  changed: number
}

function effectiveLabelDelta(
  plan: ReturnType<typeof planAction>,
  labels: ReadonlySet<string>,
  labelsOnEveryMessage: ReadonlySet<string> = labels
): { add: string[]; remove: string[] } {
  return {
    add: plan.add.filter((label) => !labelsOnEveryMessage.has(label)),
    remove: plan.remove.filter((label) => labels.has(label))
  }
}

function moveChangesReminder(reminder: SnoozeReminderSnapshot | null): boolean {
  return reminder?.state === 'pending' || reminder?.state === 'returned'
}

function sameSnoozeReminder(
  left: SnoozeReminderSnapshot | null,
  right: SnoozeReminderSnapshot | null
): boolean {
  if (left === null || right === null) return left === right
  return left.dueAt === right.dueAt && left.state === right.state
}

function sameFollowUpReminder(
  left: FollowUpReminderSnapshot | null,
  right: FollowUpReminderSnapshot | null
): boolean {
  if (left === null || right === null) return left === right
  return (
    sameSnoozeReminder(left, right) &&
    left.originMessageId === right.originMessageId &&
    left.originRfcMessageId === right.originRfcMessageId &&
    left.originInternalDate === right.originInternalDate &&
    left.originOutboxCreatedAt === right.originOutboxCreatedAt
  )
}

function restoreSnoozeIfUnchanged(
  db: Db,
  accountId: string,
  threadId: string,
  expected: SnoozeReminderSnapshot | null,
  before: SnoozeReminderSnapshot | null
): boolean {
  if (!sameSnoozeReminder(snoozeReminderSnapshot(db, accountId, threadId), expected)) return false
  restoreSnoozeReminder(db, accountId, threadId, before)
  return true
}

function restoreFollowUpIfUnchanged(
  db: Db,
  accountId: string,
  threadId: string,
  expected: FollowUpReminderSnapshot | null,
  before: FollowUpReminderSnapshot | null
): boolean {
  if (!sameFollowUpReminder(followUpReminderSnapshot(db, accountId, threadId), expected)) return false
  restoreFollowUpReminder(db, accountId, threadId, before)
  return true
}

/**
 * The deliberate follow-up triage matrix (T35/F9). Spam and Trash cancel the
 * reminder outright. Archive and a filing Move complete a returned one and
 * cancel an overdue pending one — otherwise the scheduler would resurface the
 * thread right after the user filed it — while a future deadline survives an
 * ordinary archive. A move BACK to the inbox is un-filing, not filing, so it
 * leaves the reminder alone exactly like restoreInbox (PR #101 review). No
 * other verb touches it: unlike a returned snooze, the Follow up chip holds
 * until the thread is actually filed (opening marks the thread read through
 * this same path, and reading is not answering).
 */
function settleFollowUpForTriage(
  db: Db,
  accountId: string,
  threadId: string,
  action: TriageAction,
  now: number
): number {
  if (action.kind === 'unsnooze') return 0
  if (action.kind === 'spam' || action.kind === 'trash') {
    return settleReminders(db, accountId, threadId, 'follow_up')
  }
  if (action.kind === 'archive' || (action.kind === 'move' && action.destination.kind !== 'inbox')) {
    const completed = db
      .prepare(
        `UPDATE reminders SET state = 'done'
         WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up' AND state = 'returned'`
      )
      .run(accountId, threadId).changes
    const canceled = db
      .prepare(
        `UPDATE reminders SET state = 'canceled'
         WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up' AND state = 'pending'
           AND due_at <= ?`
      )
      .run(accountId, threadId, now).changes
    return completed + canceled
  }
  return 0
}

/**
 * Files a live reminder the way triage does: a pending one is canceled, a
 * returned one is completed. Returns the number of rows it changed so callers
 * can tell whether the thread moved at all.
 */
function settleReminders(db: Db, accountId: string, threadId: string, kind: 'snooze' | 'follow_up'): number {
  return db
    .prepare(
      `UPDATE reminders SET state = CASE state WHEN 'pending' THEN 'canceled' ELSE 'done' END
       WHERE account_id = ? AND thread_id = ? AND kind = ?
         AND state IN ('pending', 'returned')`
    )
    .run(accountId, threadId, kind).changes
}

/** True when {@link settleFollowUpForTriage} will change this snapshot, so an undo must restore it. */
function followUpSettledBy(
  action: TriageAction,
  snapshot: FollowUpReminderSnapshot | null,
  now: number
): snapshot is FollowUpReminderSnapshot {
  if (action.kind !== 'archive' || snapshot === null) return false
  return snapshot.state === 'returned' || (snapshot.state === 'pending' && snapshot.dueAt <= now)
}

function movesToMailbox(action: TriageAction): boolean {
  return action.kind === 'move' || action.kind === 'spam' || action.kind === 'trash'
}

function validateMoveLabels(
  db: Db,
  accountId: string,
  action: Extract<TriageAction, { kind: 'move' }>
): void {
  const destinationLabelId = action.destination.kind === 'label' ? action.destination.labelId : null
  if (action.sourceLabelId !== null && action.sourceLabelId === destinationLabelId) {
    throw new Error('Move source and destination must differ')
  }
  const findUserLabel = db.prepare(
    "SELECT 1 FROM labels WHERE account_id = ? AND id = ? AND lower(type) = 'user'"
  )
  for (const labelId of [action.sourceLabelId, destinationLabelId]) {
    if (labelId !== null && !findUserLabel.get(accountId, labelId)) {
      throw new Error('Move label is unavailable')
    }
  }
}

interface ApplyContext {
  db: Db
  accountId: string
  action: TriageAction
  plan: ReturnType<typeof planAction>
  actionKind: RevertedActionKind
  revertsQueueId?: number
  now: number
  labelsBefore: Map<string, Set<string>>
  labelsOnEveryMessageBefore: Map<string, Set<string>> | null
  remindersBefore: Map<string, SnoozeReminderSnapshot | null>
  followUpsBefore: Map<string, FollowUpReminderSnapshot | null>
  enqueue: (payload: unknown, threadId: string) => number
  undo: UndoAction[]
  refs: QueuedActionRef[]
  changedThreads: Set<string>
}

/**
 * Filing a thread into a mailbox — Move, Spam, Trash. The inverse is the label
 * delta the forward mutation actually applied, because a thread-level Gmail
 * operation cannot recreate partial per-message membership, and it carries the
 * reminder snapshots because `apply()` never restores reminders on the way back.
 */
function applyMove(context: ApplyContext, threadId: string): void {
  const { db, accountId, action, plan, now } = context
  const labels = context.labelsBefore.get(threadId) ?? new Set<string>()
  const reminderBefore = context.remindersBefore.get(threadId) ?? null
  const followUpBefore = context.followUpsBefore.get(threadId) ?? null
  const delta = effectiveLabelDelta(plan, labels, context.labelsOnEveryMessageBefore?.get(threadId) ?? labels)
  if (
    delta.add.length === 0 &&
    delta.remove.length === 0 &&
    !moveChangesReminder(reminderBefore) &&
    !moveChangesReminder(followUpBefore)
  ) {
    return
  }
  const moveUndo: MoveUndoAction = {
    kind: 'moveUndo',
    threadIds: [threadId],
    add: [...delta.remove],
    remove: [...delta.add],
    reminderBefore,
    reminderAfter: reminderBefore,
    followUpBefore,
    followUpAfter: followUpBefore
  }
  settleReminders(db, accountId, threadId, 'snooze')
  settleFollowUpForTriage(db, accountId, threadId, action, now)
  moveUndo.reminderAfter = snoozeReminderSnapshot(db, accountId, threadId)
  moveUndo.followUpAfter = followUpReminderSnapshot(db, accountId, threadId)
  applyThreadDelta(db, accountId, { threadId, ...delta })
  context.changedThreads.add(threadId)
  if (delta.add.length === 0 && delta.remove.length === 0) {
    context.undo.push(moveUndo)
    return
  }
  const queueId = context.enqueue(
    {
      add: delta.add,
      remove: delta.remove,
      actionKind: context.actionKind,
      ...(moveChangesReminder(reminderBefore) ? { reminderBefore } : {}),
      ...(moveChangesReminder(followUpBefore) ? { followUpBefore } : {})
    },
    threadId
  )
  moveUndo.revertsQueueId = queueId
  context.undo.push(moveUndo)
  context.refs.push(queueRowRef(queueId, threadId))
}

/** Every other verb: a label delta, its inverse, and the reminders it settles. */
function applyLabelAction(context: ApplyContext, threadId: string): void {
  const { db, accountId, action, plan, now } = context
  const labels = context.labelsBefore.get(threadId) ?? new Set<string>()
  const followUpBefore = context.followUpsBefore.get(threadId) ?? null
  // The inverse reads the pre-state, so it is planned before this thread's
  // reminders and labels move.
  const primary = ((): UndoTriageAction | SnoozeAtUndoAction => {
    if (action.kind === 'unsnooze' || action.kind === 'archive') {
      const reminder = pendingSnoozeFor(db, accountId, threadId)
      if (reminder) return { kind: 'snoozeAt', threadIds: [threadId], dueAt: reminder.dueAt }
    }
    return inverseForThread(action, labels, threadId)
  })()
  let reminderChanges = 0
  if (action.kind === 'unsnooze') {
    reminderChanges = db
      .prepare("DELETE FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'snooze'")
      .run(accountId, threadId).changes
  } else if (action.kind === 'archive') {
    reminderChanges = settleReminders(db, accountId, threadId, 'snooze')
  } else {
    reminderChanges = db
      .prepare(
        `UPDATE reminders SET state = 'done'
         WHERE account_id = ? AND thread_id = ? AND kind = 'snooze' AND state = 'returned'`
      )
      .run(accountId, threadId).changes
  }
  reminderChanges += settleFollowUpForTriage(db, accountId, threadId, action, now)
  applyThreadDelta(db, accountId, { threadId, add: plan.add, remove: plan.remove })
  // An action the thread already satisfies — archive from a non-inbox view,
  // a star that is already on — has nothing to send and nothing to undo.
  const delta = effectiveLabelDelta(plan, labels)
  const labelsChanged = delta.add.length > 0 || delta.remove.length > 0
  let queueId: number | null = null
  if (labelsChanged) {
    const reminderBefore = recoveryReminderForAction(action, context.remindersBefore.get(threadId) ?? null)
    queueId = context.enqueue(
      {
        add: plan.add,
        remove: plan.remove,
        actionKind: context.actionKind,
        reminderBefore,
        ...(moveChangesReminder(followUpBefore) ? { followUpBefore } : {}),
        ...(context.revertsQueueId ? { revertsQueueId: context.revertsQueueId } : {})
      },
      threadId
    )
    context.refs.push(queueRowRef(queueId, threadId))
  }
  if (!labelsChanged && reminderChanges === 0) return
  context.changedThreads.add(threadId)
  // The undo carries the queue row it reverts, so a permanent Gmail
  // rejection of the forward action drops the pending undo with it
  // (executor dropQueuedReverts), exactly as the move path does.
  context.undo.push(
    primary.kind === 'snoozeAt' || queueId === null ? primary : { ...primary, revertsQueueId: queueId }
  )
  // Archive settles the follow-up above, and its label inverse replays
  // through apply(), which never restores reminders — so the undo entry
  // itself must carry the snapshot back (PR #101 review), exactly as
  // applyMoveUndo does for moves.
  if (followUpSettledBy(action, followUpBefore, now)) {
    context.undo.push({
      kind: 'followUpRestore',
      threadIds: [threadId],
      before: followUpBefore,
      after: {
        ...followUpBefore,
        state: followUpBefore.state === 'returned' ? 'done' : 'canceled'
      }
    })
  }
}

function apply(
  db: Db,
  accountId: string,
  action: TriageAction,
  actionKind = noticeKindForAction(action),
  revertsQueueId?: number
): ApplyResult {
  const plan = planAction(action)
  const labelsBefore = new Map(
    action.threadIds.map((threadId) => [threadId, labelsFor(db, accountId, threadId)] as const)
  )
  const insert = db.prepare(
    `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
     VALUES (?, ?, ?, ?, 'pending')`
  )
  const context: ApplyContext = {
    db,
    accountId,
    action,
    plan,
    actionKind,
    revertsQueueId,
    now: Date.now(),
    labelsBefore,
    labelsOnEveryMessageBefore: movesToMailbox(action)
      ? new Map(
          action.threadIds.map((threadId) => [
            threadId,
            labelsOnEveryMessageFor(db, accountId, threadId, labelsBefore.get(threadId) ?? new Set())
          ])
        )
      : null,
    remindersBefore: new Map(
      action.threadIds.map((threadId) => [threadId, snoozeReminderSnapshot(db, accountId, threadId)] as const)
    ),
    followUpsBefore: new Map(
      action.threadIds.map(
        (threadId) => [threadId, followUpReminderSnapshot(db, accountId, threadId)] as const
      )
    ),
    enqueue: (payload, threadId) =>
      Number(insert.run(accountId, plan.queueKind, threadId, JSON.stringify(payload)).lastInsertRowid),
    undo: [],
    refs: [],
    changedThreads: new Set<string>()
  }
  // The two flows share the loop and nothing else: a mailbox move inverts the
  // delta it actually applied and carries reminder snapshots, while every
  // other verb inverts against the thread's pre-state.
  db.transaction(() => {
    for (const threadId of action.threadIds) {
      if (movesToMailbox(action)) applyMove(context, threadId)
      else applyLabelAction(context, threadId)
    }
  })()
  return { undo: context.undo, refs: context.refs, changed: context.changedThreads.size }
}

function applyMoveUndo(db: Db, accountId: string, action: MoveUndoAction): void {
  const [threadId] = action.threadIds
  if (!threadId) return
  const reminderBeforeUndo = snoozeReminderSnapshot(db, accountId, threadId)
  const followUpBeforeUndo = followUpReminderSnapshot(db, accountId, threadId)
  if (action.add.length > 0 || action.remove.length > 0) {
    applyThreadDelta(db, accountId, { threadId, add: action.add, remove: action.remove })
    db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
       VALUES (?, 'modifyLabels', ?, ?, 'pending')`
    ).run(
      accountId,
      threadId,
      JSON.stringify({
        add: action.add,
        remove: action.remove,
        actionKind: 'undo',
        reminderBefore: reminderBeforeUndo,
        followUpBefore: followUpBeforeUndo,
        ...(action.revertsQueueId ? { revertsQueueId: action.revertsQueueId } : {})
      })
    )
  }
  restoreSnoozeIfUnchanged(db, accountId, threadId, action.reminderAfter, action.reminderBefore)
  const restoredFollowUp = restoreFollowUpIfUnchanged(
    db,
    accountId,
    threadId,
    action.followUpAfter,
    action.followUpBefore
  )
  // A qualifying reply can arrive between the move and its undo; the restored
  // snapshot predates it, so re-settle against the cached messages rather
  // than resurrecting an answered reminder (PR #101 review).
  if (restoredFollowUp) evaluateThreadFollowUp(db, accountId, threadId)
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
    const followUpBefore = followUpReminderSnapshot(db, accountId, threadId)
    upsertReminder.run(accountId, threadId, dueAt)
    // Snoozing a returned follow-up postpones it: pending again until the new
    // snooze returns, when the joint settle resurfaces both (T35/F9).
    db.prepare(
      `UPDATE reminders SET state = 'pending'
       WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up' AND state = 'returned'`
    ).run(accountId, threadId)
    applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
    // v1 snooze is local-only by decision (SPEC §9 #6): Gmail sees a plain
    // archive. Gmail-side labels + exact-time return arrive with the v1.5
    // companion script (SPEC F7).
    if (wasInInbox) {
      const queued = enqueue.run(
        accountId,
        threadId,
        JSON.stringify({
          add: [],
          remove: ['INBOX'],
          actionKind,
          reminderBefore,
          ...(followUpBefore?.state === 'returned' ? { followUpBefore } : {})
        })
      )
      refs.push(queueRowRef(Number(queued.lastInsertRowid), threadId))
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
  if (action.kind === 'move') validateMoveLabels(db, accountId, action)
  const { undo, refs, changed } = apply(db, accountId, action)
  const label = actionLabel(action, changed)
  if (recordUndo && undo.length > 0) {
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
  return { label: changed > 0 ? label : 'Already there' }
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
      else if (action.kind === 'moveUndo') applyMoveUndo(db, accountId, action)
      else if (action.kind === 'followUpRestore') {
        for (const threadId of action.threadIds) {
          const restored = restoreFollowUpIfUnchanged(db, accountId, threadId, action.after, action.before)
          // A reply cached between the archive and this undo answers the
          // reminder; the restored snapshot must not resurrect it
          // (PR #101 review).
          if (restored) evaluateThreadFollowUp(db, accountId, threadId)
        }
      } else apply(db, accountId, action, 'undo', action.revertsQueueId)
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
    case 'move': {
      const destination = action.destination
      return (
        isMoveDestination(destination) &&
        (typeof action.sourceLabelId === 'string' || action.sourceLabelId === null) &&
        (action.verb === undefined ||
          (action.verb === 'markNotDone' && destination.kind === 'inbox' && action.sourceLabelId === null)) &&
        (destination.kind !== 'label' || destination.labelId !== action.sourceLabelId)
      )
    }
    default:
      return false
  }
}

export function pendingActionCount(db: Db, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM action_queue
       WHERE account_id = ? AND state IN ('pending', 'inflight', 'recovering')`
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
       WHERE account_id = ? AND state IN ('pending', 'inflight', 'recovering')
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
  if (
    (action.kind === 'archive' || action.kind === 'move') &&
    (reminder?.state === 'pending' || reminder?.state === 'returned')
  ) {
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
    case 'move':
      return 'move'
  }
}
