import { useCallback, useEffect, useRef, useState } from 'react'
import { prunedToVisible } from '../selection'

interface SelectableThread {
  id: string
}

interface SelectionState {
  selectedIds: ReadonlySet<string>
  clearSelection: () => void
  toggleFocusedSelection: () => void
  extendSelectionTo: (index: number) => void
  /** Shift+J/K: the caller must not have to know the focused index (P1). */
  extendSelectionBy: (delta: number) => void
}

export function useSelectionState(
  threads: SelectableThread[],
  selectedIndex: number,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): SelectionState {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [baseIds, setBaseIds] = useState<ReadonlySet<string>>(new Set())
  // Every input is read through a ref so these callbacks keep one identity for
  // the life of the mount. They reach the ~60-command batch `useInboxCommands`
  // registers and the memoized ThreadList, both of which would otherwise be
  // rebuilt on each J/K and each background list refresh (P1, P3).
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const anchorIdRef = useRef(anchorId)
  anchorIdRef.current = anchorId
  const baseIdsRef = useRef(baseIds)
  baseIdsRef.current = baseIds
  const setSelectedIndexRef = useRef(setSelectedIndex)
  setSelectedIndexRef.current = setSelectedIndex

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setAnchorId(null)
    setBaseIds(new Set())
  }, [])

  // The range-extend base is pruned with the selection. Leaving a dropped id in
  // `baseIds` lets the next Shift+arrow re-add a thread that is no longer listed,
  // and this effect would not run again to remove it.
  useEffect(() => {
    setSelectedIds((current) => prunedToVisible(current, threads))
    setBaseIds((current) => prunedToVisible(current, threads))
  }, [threads])

  useEffect(() => {
    setAnchorId((anchor) =>
      anchor !== null && selectedIds.has(anchor) && threads.some((thread) => thread.id === anchor)
        ? anchor
        : null
    )
  }, [selectedIds, threads])

  const toggleFocusedSelection = useCallback(() => {
    const threads = threadsRef.current
    const thread = threads[selectedIndexRef.current]
    if (!thread) return
    const next = new Set(selectedIdsRef.current)
    const isAdding = !next.has(thread.id)
    if (isAdding) next.add(thread.id)
    else next.delete(thread.id)
    setSelectedIds(next)
    setBaseIds(next)
    if (isAdding) setAnchorId(thread.id)
    else if (next.size === 0 || anchorIdRef.current === thread.id) setAnchorId(null)
  }, [])

  const extendSelectionTo = useCallback((nextIndex: number) => {
    const threads = threadsRef.current
    if (threads.length === 0) return
    const selectedIds = selectedIdsRef.current
    const anchorId = anchorIdRef.current
    const clampedIndex = Math.max(0, Math.min(nextIndex, threads.length - 1))
    const storedAnchorIndex = anchorId ? threads.findIndex((thread) => thread.id === anchorId) : -1
    const hasAnchor = storedAnchorIndex >= 0
    const anchorIndex = hasAnchor ? storedAnchorIndex : selectedIndexRef.current
    const start = Math.min(anchorIndex, clampedIndex)
    const end = Math.max(anchorIndex, clampedIndex)
    const next = new Set(hasAnchor ? baseIdsRef.current : selectedIds)
    for (const thread of threads.slice(start, end + 1)) next.add(thread.id)
    setSelectedIds(next)
    if (!hasAnchor) setBaseIds(selectedIds)
    setAnchorId(threads[anchorIndex]?.id ?? null)
    setSelectedIndexRef.current(clampedIndex)
  }, [])

  const extendSelectionBy = useCallback(
    (delta: number) => extendSelectionTo(selectedIndexRef.current + delta),
    [extendSelectionTo]
  )

  return {
    selectedIds,
    clearSelection,
    toggleFocusedSelection,
    extendSelectionTo,
    extendSelectionBy
  }
}
