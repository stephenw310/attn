export type RevertedActionKind =
  | 'archive'
  | 'trash'
  | 'restoreInbox'
  | 'untrash'
  | 'snooze'
  | 'snoozeReturn'
  | 'followUpReturn'
  | 'unsnooze'
  | 'undo'
  | 'spam'
  | 'star'
  | 'unstar'
  | 'markRead'
  | 'markUnread'
  | 'labels'
  | 'move'

export interface RevertedAction {
  threadId: string
  subject: string
  kind: RevertedActionKind
  returnedToInbox: boolean
  resolution: 'restored' | 'unavailable' | 'keptLocal'
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
  snoozeReturn: 'return snoozed',
  followUpReturn: 'resurface for follow-up',
  unsnooze: 'unsnooze',
  undo: 'undo the change to',
  spam: 'mark as spam',
  star: 'star',
  unstar: 'unstar',
  markRead: 'mark as read',
  markUnread: 'mark as unread',
  labels: 'update labels for',
  move: 'move'
}

export function formatActionRevertToast(actions: readonly RevertedAction[]): string | null {
  if (actions.length === 0) return null
  const unavailable = actions.filter((action) => action.resolution === 'unavailable')
  const keptLocal = actions.filter((action) => action.resolution === 'keptLocal')
  if (actions.length > 1) {
    if (unavailable.length > 0) {
      return unavailable.length === actions.length
        ? `Couldn't complete ${actions.length} mail actions, and Gmail's current versions couldn't be loaded. Cached copies were kept.`
        : `Couldn't complete ${actions.length} mail actions — some Gmail versions couldn't be loaded, so their cached copies were kept.`
    }
    if (keptLocal.length > 0) {
      return keptLocal.length === actions.length
        ? `Couldn't return ${actions.length} snoozed conversations in Gmail — they remain in your Attn inbox.`
        : `Couldn't complete ${actions.length} mail actions — returned snoozes remain in your Attn inbox.`
    }
    const allArchived = actions.every((action) => action.kind === 'archive' && action.returnedToInbox)
    return allArchived
      ? `Couldn't archive ${actions.length} conversations — they're back in your inbox.`
      : `Couldn't complete ${actions.length} mail actions — Gmail's versions were restored.`
  }

  const [action] = actions
  const subject = toastSubject(action.subject)
  if (action.resolution === 'unavailable') {
    return `Couldn't ${actionPhrase[action.kind]} '${subject}', and Gmail's current version couldn't be loaded. The cached copy was kept.`
  }
  if (action.resolution === 'keptLocal') {
    return `Couldn't ${actionPhrase[action.kind]} '${subject}' in Gmail — it remains in your Attn inbox.`
  }
  const outcome =
    action.kind === 'archive' && action.returnedToInbox
      ? "it's back in your inbox."
      : "Gmail's version was restored."
  return `Couldn't ${actionPhrase[action.kind]} '${subject}' — ${outcome}`
}

function toastSubject(subject: string): string {
  const value = subject || 'Untitled conversation'
  const characters = Array.from(value)
  return characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : value
}
