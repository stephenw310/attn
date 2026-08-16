export type RevertedActionKind =
  | 'archive'
  | 'trash'
  | 'restore'
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
}

const actionPhrase: Record<RevertedActionKind, string> = {
  archive: 'archive',
  trash: 'trash',
  restore: 'restore',
  spam: 'mark as spam',
  star: 'star',
  unstar: 'unstar',
  markRead: 'mark as read',
  markUnread: 'mark as unread',
  labels: 'update labels for'
}

export function formatActionRevertToast(actions: readonly RevertedAction[]): string | null {
  if (actions.length === 0) return null
  if (actions.length > 1) {
    const allArchived = actions.every((action) => action.kind === 'archive' && action.returnedToInbox)
    return allArchived
      ? `Couldn't archive ${actions.length} conversations — they're back in your inbox.`
      : `Couldn't complete ${actions.length} mail actions — Gmail's versions were restored.`
  }

  const [action] = actions
  const subject = action.subject || 'Untitled conversation'
  const outcome =
    action.kind === 'archive' && action.returnedToInbox
      ? "it's back in your inbox."
      : "Gmail's version was restored."
  return `Couldn't ${actionPhrase[action.kind]} '${subject}' — ${outcome}`
}
