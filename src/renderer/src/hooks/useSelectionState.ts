import { useCallback, useEffect, useState } from 'react'
import { prunedToVisible } from '../selection'

interface SelectableThread {
  id: string
}

interface SelectionState {
  selectedIds: ReadonlySet<string>
  clearSelection: () => void
  resetSelection: () => void
  toggleFocusedSelection: () => void
  extendSelectionTo: (index: number) => void
}

export function useSelectionState(
  threads: SelectableThread[],
  selectedIndex: number,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): SelectionState {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [baseIds, setBaseIds] = useState<ReadonlySet<string>>(new Set())

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
    const thread = threads[selectedIndex]
    if (!thread) return
    const next = new Set(selectedIds)
    const isAdding = !next.has(thread.id)
    if (isAdding) next.add(thread.id)
    else next.delete(thread.id)
    setSelectedIds(next)
    setBaseIds(next)
    if (isAdding) setAnchorId(thread.id)
    else if (next.size === 0 || anchorId === thread.id) setAnchorId(null)
  }, [anchorId, selectedIds, selectedIndex, threads])

  const extendSelectionTo = useCallback(
    (nextIndex: number) => {
      if (threads.length === 0) return
      const clampedIndex = Math.max(0, Math.min(nextIndex, threads.length - 1))
      const storedAnchorIndex = anchorId ? threads.findIndex((thread) => thread.id === anchorId) : -1
      const hasAnchor = storedAnchorIndex >= 0
      const anchorIndex = hasAnchor ? storedAnchorIndex : selectedIndex
      const start = Math.min(anchorIndex, clampedIndex)
      const end = Math.max(anchorIndex, clampedIndex)
      const next = new Set(hasAnchor ? baseIds : selectedIds)
      for (const thread of threads.slice(start, end + 1)) next.add(thread.id)
      setSelectedIds(next)
      if (!hasAnchor) setBaseIds(selectedIds)
      setAnchorId(threads[anchorIndex]?.id ?? null)
      setSelectedIndex(clampedIndex)
    },
    [anchorId, baseIds, selectedIds, selectedIndex, setSelectedIndex, threads]
  )

  return {
    selectedIds,
    clearSelection,
    resetSelection: clearSelection,
    toggleFocusedSelection,
    extendSelectionTo
  }
}
