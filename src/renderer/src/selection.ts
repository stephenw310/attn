interface ThreadIdentity {
  id: string
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
