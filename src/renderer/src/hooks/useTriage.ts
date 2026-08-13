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
  return useCallback(
    (action: TriageAction) => {
      if (!window.attn) return
      options.preserveSelectionOnRefreshRef.current = false
      const isBulk = options.selectedIds.size > 0
      const targetedAction = { ...action, threadIds: isBulk ? [...options.selectedIds] : action.threadIds }
      if (isBulk) options.clearSelection()
      if (action.kind === 'archive' && options.view === 'inbox' && !options.readerOpen) {
        options.setExitingThreadIds((current) => new Set([...current, ...targetedAction.threadIds]))
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550
        options.deferRefreshUntilRef.current = Math.max(
          options.deferRefreshUntilRef.current,
          Date.now() + duration
        )
        options.earliestExitIndexRef.current = Math.min(
          options.earliestExitIndexRef.current ?? options.selectedIndex,
          options.selectedIndex
        )
        options.setSelectedIndex((index) =>
          Math.min(index + targetedAction.threadIds.length, options.threadCount - 1)
        )
        window.setTimeout(() => {
          const earliest = options.earliestExitIndexRef.current
          options.earliestExitIndexRef.current = null
          if (earliest !== null) options.setSelectedIndex(earliest)
        }, duration)
      }
      void window.attn.mail
        .triage(targetedAction)
        .then((result) => options.showToast(result.label))
        .catch(() => {
          options.preserveSelectionOnRefreshRef.current = true
          options.setExitingThreadIds((current) => {
            const next = new Set(current)
            for (const id of targetedAction.threadIds) next.delete(id)
            return next
          })
        })
    },
    [options]
  )
}
