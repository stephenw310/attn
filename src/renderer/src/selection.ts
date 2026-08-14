interface ThreadIdentity {
  id: string
}

/**
 * Drop ids that are no longer in the list. Both the live selection and the
 * range-extend base need this: a base that keeps a dropped id re-adds it to the
 * selection on the next Shift+arrow, which would then target an invisible thread.
 * Returns the original set when nothing changed so React can skip the update.
 */
export function prunedToVisible(ids: ReadonlySet<string>, threads: ThreadIdentity[]): ReadonlySet<string> {
  if (ids.size === 0) return ids
  const visibleIds = new Set(threads.map((thread) => thread.id))
  const next = new Set([...ids].filter((id) => visibleIds.has(id)))
  return next.size === ids.size ? ids : next
}

/** Preserve selection by identity across reordered/inserted background refreshes. */
export function refreshedSelectionIndex(
  threads: ThreadIdentity[],
  selectedThreadId: string | null,
  previousIndex: number
): number {
  if (selectedThreadId) {
    const preserved = threads.findIndex((thread) => thread.id === selectedThreadId)
    if (preserved >= 0) return preserved
  }
  return Math.max(0, Math.min(previousIndex, Math.max(threads.length - 1, 0)))
}
