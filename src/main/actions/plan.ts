import type { TriageAction } from '../../shared/actions'

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
      return { add: ['INBOX'], remove: [], queueKind: 'modifyLabels' }
    case 'trash':
      return { add: [], remove: ['INBOX'], queueKind: 'trash' }
    case 'untrash':
      return { add: ['INBOX'], remove: [], queueKind: 'untrash' }
    case 'spam':
      return { add: ['SPAM'], remove: ['INBOX'], queueKind: 'modifyLabels' }
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
  }
}

export function actionLabel(action: TriageAction): string {
  const count = action.threadIds.length
  const plural = (one: string, many: string): string => (count === 1 ? one : `${count} ${many}`)
  switch (action.kind) {
    case 'archive':
      return plural('Archived', 'archived')
    case 'restoreInbox':
      return plural('Restored', 'restored')
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
    case 'trash':
      return { kind: 'untrash', threadIds: [threadId] }
    case 'untrash':
      return { kind: 'trash', threadIds: [threadId] }
    case 'spam':
      return {
        kind: 'label',
        threadIds: [threadId],
        add: labels.has('INBOX') ? ['INBOX'] : [],
        remove: ['SPAM']
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
  }
}
