import type { TriageAction } from '../../shared/actions'
import { moveLabelDelta } from '../../shared/move'

export interface ThreadActionPlan {
  add: string[]
  remove: string[]
  queueKind: 'modifyLabels' | 'trash' | 'untrash'
}

export function planAction(action: TriageAction): ThreadActionPlan {
  switch (action.kind) {
    case 'archive':
      return { add: [], remove: ['INBOX'], queueKind: 'modifyLabels' }
    case 'restoreInbox':
    case 'unsnooze':
      return { add: ['INBOX'], remove: [], queueKind: 'modifyLabels' }
    case 'trash':
    case 'spam': {
      const delta = moveLabelDelta({ kind: action.kind }, null)
      return { ...delta, queueKind: 'modifyLabels' }
    }
    case 'untrash': {
      const delta = moveLabelDelta({ kind: 'inbox' }, null)
      return { ...delta, queueKind: 'modifyLabels' }
    }
    case 'star':
      return {
        add: action.on ? ['STARRED'] : [],
        remove: action.on ? [] : ['STARRED'],
        queueKind: 'modifyLabels'
      }
    case 'markUnread':
      return {
        add: action.on ? ['UNREAD'] : [],
        remove: action.on ? [] : ['UNREAD'],
        queueKind: 'modifyLabels'
      }
    case 'label':
      return { add: action.add, remove: action.remove, queueKind: 'modifyLabels' }
    case 'move': {
      const delta = moveLabelDelta(action.destination, action.sourceLabelId)
      return { ...delta, queueKind: 'modifyLabels' }
    }
  }
}

/**
 * `count` defaults to the action's own thread count, and is overridden when an
 * undo entry has shrunk — a rejected action drops its thread from the inverse,
 * so the label must not keep advertising the original size.
 */
export function actionLabel(action: TriageAction, count = action.threadIds.length): string {
  const plural = (one: string, many: string): string => (count === 1 ? one : `${count} ${many}`)
  switch (action.kind) {
    case 'archive':
      return plural('Archived', 'archived')
    case 'restoreInbox':
      return plural('Restored', 'restored')
    case 'unsnooze':
      return plural('Unsnoozed', 'unsnoozed')
    case 'trash':
      return plural('Trashed', 'trashed')
    case 'untrash':
      return plural('Restored from trash', 'restored from trash')
    case 'spam':
      return plural('Marked spam', 'marked spam')
    case 'star':
      return action.on ? plural('Starred', 'starred') : plural('Unstarred', 'unstarred')
    case 'markUnread':
      return action.on ? plural('Marked unread', 'marked unread') : plural('Marked read', 'marked read')
    case 'label':
      return plural('Labels updated', 'labels updated')
    case 'move':
      return plural('Moved', 'moved')
  }
}

export function inverseForThread(
  action: TriageAction,
  labels: ReadonlySet<string>,
  threadId: string
): TriageAction {
  switch (action.kind) {
    case 'archive':
      return { kind: 'restoreInbox', threadIds: [threadId] }
    case 'restoreInbox':
      return { kind: 'archive', threadIds: [threadId] }
    case 'unsnooze':
      return { kind: 'archive', threadIds: [threadId] }
    case 'trash':
    case 'untrash':
    case 'spam': {
      const plan = planAction(action)
      return {
        kind: 'label',
        threadIds: [threadId],
        add: plan.remove.filter((label) => labels.has(label)),
        remove: plan.add.filter((label) => !labels.has(label))
      }
    }
    case 'star':
      return { kind: 'star', threadIds: [threadId], on: labels.has('STARRED') }
    case 'markUnread':
      return { kind: 'markUnread', threadIds: [threadId], on: labels.has('UNREAD') }
    case 'label':
      return {
        kind: 'label',
        threadIds: [threadId],
        add: action.remove.filter((label) => labels.has(label)),
        remove: action.add.filter((label) => !labels.has(label))
      }
    case 'move': {
      const plan = planAction(action)
      return {
        kind: 'label',
        threadIds: [threadId],
        add: plan.remove.filter((label) => labels.has(label)),
        remove: plan.add.filter((label) => !labels.has(label))
      }
    }
  }
}
