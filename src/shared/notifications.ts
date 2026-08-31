export const NOTIFICATION_SUMMARY_THRESHOLD = 3

/** Local midnight at the start of the next day — the "until tomorrow" pause deadline. */
export function tomorrowStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
}

export function oneHourFrom(now = Date.now()): number {
  return now + 60 * 60 * 1000
}

/**
 * What a notification click asks the renderer to do (F12/F18). A `focus`
 * target names the account already on screen — open the thread, or land on
 * the inbox for a summary (`threadId: null`). A `switch` target names an
 * inactive account: the renderer runs its guarded account switch first, and
 * the target stays pending in the main process until the remounted tree for
 * the right account pulls it again.
 *
 * A `focus` pull does NOT consume the target: the tree that received it calls
 * `acknowledgePendingFocus(id)` once it has accepted the click, and only that
 * clears it. A pull whose delivery dies in a torn-down subscription (an
 * account remount, an effect cleanup) therefore cannot silently lose the
 * click — the next live tree pulls the same target again (T32 regression).
 * `accountId` lets a stale tree recognize a target that is not its own and
 * leave it un-acknowledged.
 */
export type PendingFocusTarget =
  | { kind: 'focus'; accountId: string; threadId: string | null; id: number }
  | { kind: 'switch'; accountId: string }
