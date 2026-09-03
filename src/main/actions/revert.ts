import type { RevertedAction, RevertedActionKind } from '../../shared/actionRevert'
import type { QueueIntent } from './execute'

export interface QueuedActionRef {
  queueId: number
  threadId: string
}

export interface UndoEntryWithRefs {
  label: string
  /** Rebuilds the label for a shrunken entry, so the undo toast counts truthfully. */
  labelFor: (threadCount: number) => string
  undo: readonly { threadIds: readonly string[] }[]
  refs: readonly QueuedActionRef[]
}

/** The pair an undo entry needs to drop itself when Gmail rejects its forward action. */
export function queueRowRef(queueId: number, threadId: string): QueuedActionRef {
  return { queueId, threadId }
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
    // A thread can carry a companion undo action (a follow-up restore riding
    // its archive), so the toast counts surviving threads, not actions.
    const survivingThreads = new Set(undo.flatMap((action) => action.threadIds))
    return [
      {
        ...entry,
        label: entry.labelFor(survivingThreads.size),
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

/** A stand-in intent for a queue row whose payload is unusable or undecodable. */
export function syntheticIntent(threadId: string): QueueIntent {
  return { kind: 'modifyLabels', threadId, add: [], remove: [] }
}

export function unavailableAction(
  threadId: string,
  subject: string,
  actionKind?: RevertedActionKind
): RevertedAction {
  return revertedAction(syntheticIntent(threadId), subject, false, 'unavailable', actionKind)
}

function revertedActionKind(intent: QueueIntent): RevertedActionKind {
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
