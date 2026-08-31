// Per-account historical sync limit (SPEC F2/F15, §9 #22). The stored
// preference bounds only the lifetime header sweep's additional fetching; an
// absent or invalid row falls back to the compile-time default, and 0 means
// All mail. Applying a change never resets auth, pollers, or send executors —
// it invalidates the in-flight historical chain's writes, persists the
// preference (plus the attachment-pass invalidation an expansion needs) in
// one transaction, and schedules only this account's historical work again.

import type { Db } from '../db'
import { deleteAccountSetting, readAccountSetting, writeAccountSetting } from '../settings'
import { LIFETIME_THREAD_CAP, LIFETIME_THREAD_CAP_UNLIMITED } from './tuning'

export const LIFETIME_CAP_SETTING = 'lifetimeThreadCap'

/** The stored override, or null when the compile-time default applies. */
export function storedLifetimeThreadCap(db: Db, accountId: string): number | null {
  const raw = readAccountSetting(db, accountId, LIFETIME_CAP_SETTING)
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** What every production lifetime run reads at its start. */
export function effectiveLifetimeThreadCap(db: Db, accountId: string): number {
  return storedLifetimeThreadCap(db, accountId) ?? LIFETIME_THREAD_CAP
}

/** Does moving from `previous` to `next` allow more historical fetching? */
export function capExpandsCoverage(previous: number, next: number): boolean {
  if (next === LIFETIME_THREAD_CAP_UNLIMITED) return previous !== LIFETIME_THREAD_CAP_UNLIMITED
  if (previous === LIFETIME_THREAD_CAP_UNLIMITED) return false
  return next > previous
}

/** The two chain operations a cap change needs from the owning controller. */
export interface LifetimeChainControl {
  invalidateLifetimeChain: () => void
  restartLifetimeChain: () => void
}

interface StoredChainCursors {
  sweep_cursor: string | null
  attachment_cursor: string | null
}

/**
 * Persist a new cap and apply it to the running chain. Order matters:
 * 1. Invalidate the old run's write generation so a mid-flight page cannot
 *    checkpoint over the state written below.
 * 2. In one transaction, persist the preference and — when the change expands
 *    a *reached* limit past an attachment pass that already started — reset
 *    the attachment cursor, so newly imported older mail cannot stay
 *    permanently unflagged. A completed pass is the obvious case, but a
 *    partial pass has the same hole: pages it already walked precede the ids
 *    the expansion imports, so resuming from its token would skip them
 *    forever (PR #101 review). The ids-only pass re-runs from page one after
 *    the expanded walk stops.
 * 3. Schedule this account's historical work again. The shared indexing slot
 *    serializes the replacement behind the settling old chain, which releases
 *    the slot exactly once in its own settle path. Saving never waits for a
 *    network response, and an unchanged cap schedules nothing.
 *
 * A truly exhausted `done` sweep cursor stays done, and a lowered or
 * unchanged reached limit makes no further lifetime Gmail requests (the
 * sweep's own at-cap check answers before any request). Unrelated cursors —
 * history, mailbox, FTS, split metadata — are never touched.
 */
export function applyLifetimeCapChange(
  db: Db,
  controller: LifetimeChainControl | null,
  accountId: string,
  next: number | null
): void {
  const previousEffective = effectiveLifetimeThreadCap(db, accountId)
  const nextEffective = next ?? LIFETIME_THREAD_CAP
  const storedBefore = storedLifetimeThreadCap(db, accountId)
  if (storedBefore === next) return
  const changesEffectiveCap = previousEffective !== nextEffective
  if (changesEffectiveCap) controller?.invalidateLifetimeChain()
  const cursors = db
    .prepare('SELECT sweep_cursor, attachment_cursor FROM sync_state WHERE account_id = ?')
    .get(accountId) as StoredChainCursors | undefined
  const expandsReachedLimit =
    capExpandsCoverage(previousEffective, nextEffective) &&
    (cursors?.sweep_cursor?.startsWith('capped:') ?? false)
  db.transaction(() => {
    if (next === null) deleteAccountSetting(db, accountId, LIFETIME_CAP_SETTING)
    else writeAccountSetting(db, accountId, LIFETIME_CAP_SETTING, String(next))
    if (expandsReachedLimit && cursors?.attachment_cursor != null) {
      db.prepare('UPDATE sync_state SET attachment_cursor = ? WHERE account_id = ?').run(
        'attachments',
        accountId
      )
    }
  })()
  if (changesEffectiveCap) controller?.restartLifetimeChain()
}
