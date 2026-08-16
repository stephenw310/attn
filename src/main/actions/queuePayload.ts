import type { RevertedActionKind } from '../../shared/actionRevert'

export interface LabelDeltaPayload {
  add: string[]
  remove: string[]
  actionKind?: RevertedActionKind
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
  return { add, remove, ...(candidate.actionKind ? { actionKind: candidate.actionKind } : {}) }
}

const actionKinds = new Set<RevertedActionKind>([
  'archive',
  'trash',
  'restoreInbox',
  'untrash',
  'snooze',
  'unsnooze',
  'undo',
  'spam',
  'star',
  'unstar',
  'markRead',
  'markUnread',
  'labels'
])

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
