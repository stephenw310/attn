export const NOTIFICATION_SUMMARY_THRESHOLD = 3

/**
 * What a notification click asks the renderer to do (F12/F18). A `focus`
 * target is for the account already on screen — open the thread, or land on
 * the inbox for a summary (`threadId: null`). A `switch` target names an
 * inactive account: the renderer runs its guarded account switch first, and
 * the target stays pending in the main process until the remounted tree for
 * the right account pulls it again.
 */
export type PendingFocusTarget =
  | { kind: 'focus'; threadId: string | null }
  | { kind: 'switch'; accountId: string }
