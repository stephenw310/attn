import { useCallback } from 'react'
import type { TriageAction } from '../../../shared/actions'

interface Options {
  selectedIds: ReadonlySet<string>
  selectedIndex: number
  threads: readonly { id: string }[]
  readerOpen: boolean
  view: 'inbox' | 'snoozed'
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
  selectedThreadIdRef: React.RefObject<string | null>
  clearSelection: () => void
  showToast: (message: string) => void
  setExitingThreadIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
}

export function useTriage(options: Options): (action: TriageAction) => void {
  const {
    selectedIds,
    selectedIndex,
    threads,
    readerOpen,
    view,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    selectedThreadIdRef,
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
      let selectionRollback: { fromId: string; toId: string | null } | null = null
      if (isBulk) clearSelection()
      if (action.kind === 'archive' && view === 'inbox' && !readerOpen) {
        setExitingThreadIds((current) => new Set([...current, ...targetedAction.threadIds]))
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550
        deferRefreshUntilRef.current = Math.max(deferRefreshUntilRef.current, Date.now() + duration)
        const targetedIds = new Set(targetedAction.threadIds)
        let nextIndex = selectedIndex
        while (nextIndex < threads.length && targetedIds.has(threads[nextIndex].id)) nextIndex++
        if (nextIndex >= threads.length) {
          nextIndex = selectedIndex - 1
          while (nextIndex >= 0 && targetedIds.has(threads[nextIndex].id)) nextIndex--
        }
        const nextThread = threads[nextIndex]
        const selectedThread = threads[selectedIndex]
        if (selectedThread) selectionRollback = { fromId: selectedThread.id, toId: nextThread?.id ?? null }
        selectedThreadIdRef.current = nextThread?.id ?? null
        preserveSelectionOnRefreshRef.current = nextThread !== undefined
        setSelectedIndex(Math.max(0, nextIndex))
      }
      void window.attn.mail
        .triage(targetedAction)
        .then((result) => showToast(result.label))
        .catch(() => {
          preserveSelectionOnRefreshRef.current = true
          if (selectionRollback && selectedThreadIdRef.current === selectionRollback.toId) {
            const rollbackIndex = threads.findIndex((thread) => thread.id === selectionRollback.fromId)
            if (rollbackIndex >= 0) {
              selectedThreadIdRef.current = selectionRollback.fromId
              setSelectedIndex(rollbackIndex)
            }
          }
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
      preserveSelectionOnRefreshRef,
      readerOpen,
      selectedIds,
      selectedIndex,
      selectedThreadIdRef,
      setExitingThreadIds,
      setSelectedIndex,
      showToast,
      threads,
      view
    ]
  )
}
