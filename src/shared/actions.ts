export type TriageAction =
  | { kind: 'archive' | 'trash' | 'spam'; threadIds: string[] }
  | { kind: 'star' | 'markUnread'; threadIds: string[]; on: boolean }
  | { kind: 'label'; threadIds: string[]; add: string[]; remove: string[] }
  | {
      kind: 'move'
      threadIds: string[]
      destinationLabelId: string | null
      sourceLabelId: string | null
    }
  | { kind: 'restoreInbox' | 'untrash' | 'unsnooze'; threadIds: string[] }

export interface TriageResult {
  label: string
  reopenDraftId?: string
}

export interface ActionQueueStatus {
  /** Rows in the triage action queue only — the header's count also spans the outbox. */
  pending: number
  /** Rows held back by a stored auth failure, awaiting same-account reconnection. */
  paused: number
  authPaused: boolean
}
