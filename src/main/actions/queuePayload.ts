import type { RevertedActionKind } from '../../shared/actionRevert'
import { stringArray } from '../../shared/guards'
import type { FollowUpReminderSnapshot, SnoozeReminderSnapshot } from '../store/reminders'

export interface LabelDeltaPayload {
  add: string[]
  remove: string[]
  actionKind?: RevertedActionKind
  reminderBefore?: SnoozeReminderSnapshot | null
  /** Pre-action follow-up reminder, restored with the labels on revert (T35). */
  followUpBefore?: FollowUpReminderSnapshot | null
  revertsQueueId?: number
}

export function decodeLabelDelta(payload: string): LabelDeltaPayload {
  const parsed = JSON.parse(payload) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid action queue payload')
  }
  const candidate = parsed as Partial<LabelDeltaPayload>
  const add = candidate.add ?? []
  const remove = candidate.remove ?? []
  if (!stringArray(add) || !stringArray(remove)) throw new Error('Invalid action queue label delta')
  if (candidate.actionKind !== undefined && !actionKinds.has(candidate.actionKind)) {
    throw new Error('Invalid action queue action kind')
  }
  if (candidate.reminderBefore !== undefined && !validReminder(candidate.reminderBefore)) {
    throw new Error('Invalid action queue reminder snapshot')
  }
  if (candidate.followUpBefore !== undefined && !validFollowUp(candidate.followUpBefore)) {
    throw new Error('Invalid action queue follow-up snapshot')
  }
  if (
    candidate.revertsQueueId !== undefined &&
    (!Number.isSafeInteger(candidate.revertsQueueId) || candidate.revertsQueueId <= 0)
  ) {
    throw new Error('Invalid reverted action queue id')
  }
  return {
    add,
    remove,
    ...(candidate.actionKind ? { actionKind: candidate.actionKind } : {}),
    ...(candidate.reminderBefore !== undefined ? { reminderBefore: candidate.reminderBefore } : {}),
    ...(candidate.followUpBefore !== undefined ? { followUpBefore: candidate.followUpBefore } : {}),
    ...(candidate.revertsQueueId !== undefined ? { revertsQueueId: candidate.revertsQueueId } : {})
  }
}

const actionKinds = new Set<RevertedActionKind>([
  'archive',
  'trash',
  'restoreInbox',
  'untrash',
  'snooze',
  'snoozeReturn',
  'followUpReturn',
  'unsnooze',
  'undo',
  'spam',
  'star',
  'unstar',
  'markRead',
  'markUnread',
  'labels',
  'move'
])

function validReminder(value: unknown): value is SnoozeReminderSnapshot | null {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SnoozeReminderSnapshot>
  return (
    typeof candidate.dueAt === 'number' &&
    Number.isFinite(candidate.dueAt) &&
    (candidate.state === 'pending' ||
      candidate.state === 'returned' ||
      candidate.state === 'done' ||
      candidate.state === 'canceled')
  )
}

function validFollowUp(value: unknown): value is FollowUpReminderSnapshot | null {
  if (!validReminder(value)) return false
  if (value === null) return true
  const candidate = value as Partial<FollowUpReminderSnapshot>
  return (
    (candidate.originMessageId === null || typeof candidate.originMessageId === 'string') &&
    (candidate.originRfcMessageId === null || typeof candidate.originRfcMessageId === 'string') &&
    (candidate.originInternalDate === null || typeof candidate.originInternalDate === 'number')
  )
}
