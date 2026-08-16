import type { RevertedAction, RevertedActionKind } from '../../shared/actionRevert'
import type { QueueIntent } from './execute'

export interface QueuedActionRef {
  threadId: string
  signature: string
}

export interface UndoEntryWithRefs {
  refs: readonly QueuedActionRef[]
}

export function queueIntentRef(intent: QueueIntent): QueuedActionRef {
  const delta =
    intent.kind === 'modifyLabels' ? `${normalizedLabels(intent.add)}|${normalizedLabels(intent.remove)}` : ''
  return { threadId: intent.threadId, signature: `${intent.kind}|${delta}` }
}

export function sameQueuedAction(left: QueuedActionRef, right: QueuedActionRef): boolean {
  return left.threadId === right.threadId && left.signature === right.signature
}

export function dropRevertedUndoEntries<T extends UndoEntryWithRefs>(
  entries: readonly T[],
  reverted: readonly QueuedActionRef[]
): T[] {
  if (reverted.length === 0) return [...entries]
  return entries.filter(
    (entry) => !entry.refs.some((ref) => reverted.some((candidate) => sameQueuedAction(ref, candidate)))
  )
}

export function revertedAction(
  intent: QueueIntent,
  subject: string,
  returnedToInbox: boolean
): RevertedAction {
  return {
    threadId: intent.threadId,
    subject,
    kind: revertedActionKind(intent),
    returnedToInbox
  }
}

function revertedActionKind(intent: QueueIntent): RevertedActionKind {
  if (intent.kind !== 'modifyLabels') return intent.kind === 'trash' ? 'trash' : 'restore'
  const add = new Set(intent.add)
  const remove = new Set(intent.remove)
  if (add.has('SPAM')) return 'spam'
  if (add.has('STARRED')) return 'star'
  if (remove.has('STARRED')) return 'unstar'
  if (add.has('UNREAD')) return 'markUnread'
  if (remove.has('UNREAD')) return 'markRead'
  if (add.has('INBOX')) return 'restore'
  if (remove.has('INBOX')) return 'archive'
  return 'labels'
}

function normalizedLabels(labels: readonly string[]): string {
  return [...new Set(labels)].sort().join(',')
}
