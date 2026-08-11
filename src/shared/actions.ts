export type TriageAction =
  | { kind: 'archive' | 'trash' | 'spam'; threadIds: string[] }
  | { kind: 'star' | 'markUnread'; threadIds: string[]; on: boolean }
  | { kind: 'label'; threadIds: string[]; add: string[]; remove: string[] }
  | { kind: 'restoreInbox' | 'untrash'; threadIds: string[] }

export interface TriageResult {
  label: string
}
