import type { AuthAccount } from '../../shared/auth'

/**
 * Adopt a reorder response onto the live roster (F18). The response's status
 * snapshot was computed when the reorder committed, which can predate a
 * removal (or an addition) that finished while it was in flight — so only the
 * ORDER is taken, and only for accounts the live roster still contains: a
 * removed account must never be resurrected by a late response, and an
 * account the response has never heard of keeps its current position at the
 * end (PR #101 review).
 */
export function orderRoster(current: AuthAccount[], ordered: AuthAccount[]): AuthAccount[] {
  const position = new Map(ordered.map((account, index) => [account.id, index]))
  const known = current
    .filter((account) => position.has(account.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
  const unknown = current.filter((account) => !position.has(account.id))
  return [...known, ...unknown]
}
