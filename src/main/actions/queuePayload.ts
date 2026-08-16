import type { RevertedActionKind } from '../../shared/actionRevert'
import { stringArray } from '../../shared/guards'
import type { SnoozeReminderSnapshot } from '../store/reminders'

export interface LabelDeltaPayload {
  add: string[]
  remove: string[]
  actionKind?: RevertedActionKind
  reminderBefore?: SnoozeReminderSnapshot | null
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
  return {
    add,
    remove,
    ...(candidate.actionKind ? { actionKind: candidate.actionKind } : {}),
    ...(candidate.reminderBefore !== undefined ? { reminderBefore: candidate.reminderBefore } : {})
  }
}

const actionKinds = new Set<RevertedActionKind>([
  'archive',
  'trash',
  'restoreInbox',
  'untrash',
  'snooze',
  'snoozeReturn',
  'unsnooze',
  'undo',
  'spam',
  'star',
  'unstar',
  'markRead',
  'markUnread',
  'labels'
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
