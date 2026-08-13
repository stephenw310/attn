import { useCallback, useEffect, useState } from 'react'

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

  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
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
