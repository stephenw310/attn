import type { RevertedAction, RevertedActionKind } from '../../shared/actionRevert'
import type { QueueIntent } from './execute'

export interface QueuedActionRef {
  queueId: number
  threadId: string
  signature: string
}

export interface UndoEntryWithRefs {
  undo: readonly { threadIds: readonly string[] }[]
  refs: readonly QueuedActionRef[]
}

export function queueIntentRef(intent: QueueIntent, queueId: number): QueuedActionRef {
  const delta =
    intent.kind === 'modifyLabels' ? `${normalizedLabels(intent.add)}|${normalizedLabels(intent.remove)}` : ''
  return { queueId, threadId: intent.threadId, signature: `${intent.kind}|${delta}` }
}

export function queueRowRef(queueId: number, threadId: string): QueuedActionRef {
  return { queueId, threadId, signature: 'unavailable' }
}

export function sameQueuedAction(left: QueuedActionRef, right: QueuedActionRef): boolean {
  return left.queueId === right.queueId
}

export function dropRevertedUndoEntries<T extends UndoEntryWithRefs>(
  entries: readonly T[],
  reverted: readonly QueuedActionRef[]
): T[] {
  if (reverted.length === 0) return [...entries]
  const revertedIds = new Set(reverted.map((ref) => ref.queueId))
  return entries.flatMap((entry) => {
    const affectedThreads = new Set(
      entry.refs.filter((ref) => revertedIds.has(ref.queueId)).map((ref) => ref.threadId)
    )
    if (affectedThreads.size === 0) return [entry]
    const undo = entry.undo.filter(
      (action) => !action.threadIds.some((threadId) => affectedThreads.has(threadId))
    )
    if (undo.length === 0) return []
    return [
      {
        ...entry,
        undo,
        refs: entry.refs.filter((ref) => !revertedIds.has(ref.queueId))
      } as T
    ]
  })
}

export function revertedAction(
  intent: QueueIntent,
  subject: string,
  returnedToInbox: boolean,
  resolution: RevertedAction['resolution'],
  actionKind?: RevertedActionKind
): RevertedAction {
  return {
    threadId: intent.threadId,
    subject,
    kind: actionKind ?? revertedActionKind(intent),
    returnedToInbox,
    resolution
  }
}

export function unavailableAction(
  queueKind: QueueIntent['kind'],
  threadId: string,
  subject: string,
  actionKind?: RevertedActionKind
): RevertedAction {
  const intent: QueueIntent =
    queueKind === 'modifyLabels'
      ? { kind: queueKind, threadId, add: [], remove: [] }
      : { kind: queueKind, threadId }
  return revertedAction(intent, subject, false, 'unavailable', actionKind)
}

function revertedActionKind(intent: QueueIntent): RevertedActionKind {
  if (intent.kind !== 'modifyLabels') return intent.kind === 'trash' ? 'trash' : 'untrash'
  const add = new Set(intent.add)
  const remove = new Set(intent.remove)
  if (add.has('SPAM')) return 'spam'
  if (add.has('STARRED')) return 'star'
  if (remove.has('STARRED')) return 'unstar'
  if (add.has('UNREAD')) return 'markUnread'
  if (remove.has('UNREAD')) return 'markRead'
  if (add.has('INBOX')) return 'restoreInbox'
  if (remove.has('INBOX')) return 'archive'
  return 'labels'
}

function normalizedLabels(labels: readonly string[]): string {
  return [...new Set(labels)].sort().join(',')
}
