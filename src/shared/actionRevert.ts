export type RevertedActionKind =
  | 'archive'
  | 'trash'
  | 'restoreInbox'
  | 'untrash'
  | 'snooze'
  | 'unsnooze'
  | 'undo'
  | 'spam'
  | 'star'
  | 'unstar'
  | 'markRead'
  | 'markUnread'
  | 'labels'

export interface RevertedAction {
  threadId: string
  subject: string
  kind: RevertedActionKind
  returnedToInbox: boolean
  resolution: 'restored' | 'unavailable'
}

export interface ActionRevertNotice {
  id: number
  actions: RevertedAction[]
}

const actionPhrase: Record<RevertedActionKind, string> = {
  archive: 'archive',
  trash: 'trash',
  restoreInbox: 'restore to the inbox',
  untrash: 'restore from trash',
  snooze: 'snooze',
  unsnooze: 'unsnooze',
  undo: 'undo the change to',
  spam: 'mark as spam',
  star: 'star',
  unstar: 'unstar',
  markRead: 'mark as read',
  markUnread: 'mark as unread',
  labels: 'update labels for'
}

export function formatActionRevertToast(actions: readonly RevertedAction[]): string | null {
  if (actions.length === 0) return null
  const unavailable = actions.filter((action) => action.resolution === 'unavailable')
  if (actions.length > 1) {
    if (unavailable.length > 0) {
      return unavailable.length === actions.length
        ? `Couldn't complete ${actions.length} mail actions, and Gmail's current versions couldn't be loaded. Cached copies were kept.`
        : `Couldn't complete ${actions.length} mail actions — some Gmail versions couldn't be loaded, so their cached copies were kept.`
    }
    const allArchived = actions.every((action) => action.kind === 'archive' && action.returnedToInbox)
    return allArchived
      ? `Couldn't archive ${actions.length} conversations — they're back in your inbox.`
      : `Couldn't complete ${actions.length} mail actions — Gmail's versions were restored.`
  }

  const [action] = actions
  const subject = action.subject || 'Untitled conversation'
  if (action.resolution === 'unavailable') {
    return `Couldn't ${actionPhrase[action.kind]} '${subject}', and Gmail's current version couldn't be loaded. The cached copy was kept.`
  }
  const outcome =
    action.kind === 'archive' && action.returnedToInbox
      ? "it's back in your inbox."
      : "Gmail's version was restored."
  return `Couldn't ${actionPhrase[action.kind]} '${subject}' — ${outcome}`
}
