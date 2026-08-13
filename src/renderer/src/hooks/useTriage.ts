import { useCallback } from 'react'
import type { TriageAction } from '../../../shared/actions'

interface Options {
  selectedIds: ReadonlySet<string>
  selectedIndex: number
  threadCount: number
  readerOpen: boolean
  view: 'inbox' | 'snoozed'
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
  earliestExitIndexRef: React.RefObject<number | null>
  clearSelection: () => void
  showToast: (message: string) => void
  setExitingThreadIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
}

export function useTriage(options: Options): (action: TriageAction) => void {
  const {
    selectedIds,
    selectedIndex,
    threadCount,
    readerOpen,
    view,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    earliestExitIndexRef,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex
  } = options
  return useCallback(
    (action: TriageAction) => {
      if (!window.attn) return
      preserveSelectionOnRefreshRef.current = false
      const isBulk = selectedIds.size > 0
      const targetedAction = { ...action, threadIds: isBulk ? [...selectedIds] : action.threadIds }
      if (isBulk) clearSelection()
      if (action.kind === 'archive' && view === 'inbox' && !readerOpen) {
        setExitingThreadIds((current) => new Set([...current, ...targetedAction.threadIds]))
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550
        deferRefreshUntilRef.current = Math.max(deferRefreshUntilRef.current, Date.now() + duration)
        earliestExitIndexRef.current = Math.min(earliestExitIndexRef.current ?? selectedIndex, selectedIndex)
        setSelectedIndex((index) => Math.min(index + targetedAction.threadIds.length, threadCount - 1))
        window.setTimeout(() => {
          const earliest = earliestExitIndexRef.current
          earliestExitIndexRef.current = null
          if (earliest !== null) setSelectedIndex(earliest)
        }, duration)
      }
      void window.attn.mail
        .triage(targetedAction)
        .then((result) => showToast(result.label))
        .catch(() => {
          preserveSelectionOnRefreshRef.current = true
          setExitingThreadIds((current) => {
            const next = new Set(current)
            for (const id of targetedAction.threadIds) next.delete(id)
            return next
          })
        })
    },
    [
      clearSelection,
      deferRefreshUntilRef,
      earliestExitIndexRef,
      preserveSelectionOnRefreshRef,
      readerOpen,
      selectedIds,
      selectedIndex,
      setExitingThreadIds,
      setSelectedIndex,
      showToast,
      threadCount,
      view
    ]
  )
}
