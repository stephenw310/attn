import { useEffect, useRef, useState } from 'react'
import type { AccountSyncStatus } from '../../../shared/auth'

export interface AccountHealth {
  /** The freshest known health for one account, or null before its first read. */
  healthFor: (accountId: string) => AccountSyncStatus | null
  /** True while any account needs the user — a reconnect, or a hard error. */
  needsAttention: boolean
}

export function accountNeedsAttention(health: AccountSyncStatus | null | undefined): boolean {
  return health?.phase === 'reconnect' || health?.phase === 'error'
}

/**
 * Per-account health for a surface that lists the roster (F18). The pushed
 * statuses move only on phase changes — they are what keeps the header chip
 * live — so their unread counts can lag, and a surface re-reads the full set
 * once when it opens. A later push supersedes that snapshot, including when it
 * arrives while the snapshot request is still in flight.
 */
export function useAccountHealth(
  accountStatuses: readonly AccountSyncStatus[] | null,
  open: boolean
): AccountHealth {
  const [openedStatuses, setOpenedStatuses] = useState<{
    statuses: AccountSyncStatus[]
    source: readonly AccountSyncStatus[] | null
  } | null>(null)
  const pushedStatusesRef = useRef(accountStatuses)
  pushedStatusesRef.current = accountStatuses

  useEffect(() => {
    if (!open || !window.attn) return
    let stale = false
    const source = pushedStatusesRef.current
    window.attn.auth
      .getAccountStatuses()
      .then((statuses) => {
        if (!stale) setOpenedStatuses({ statuses, source })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [open])

  const healthById = new Map(
    [
      ...(accountStatuses ?? []),
      ...(openedStatuses?.source === accountStatuses ? openedStatuses.statuses : [])
    ].map((health) => [health.accountId, health])
  )

  return {
    healthFor: (accountId) => healthById.get(accountId) ?? null,
    needsAttention: (accountStatuses ?? []).some(accountNeedsAttention)
  }
}
