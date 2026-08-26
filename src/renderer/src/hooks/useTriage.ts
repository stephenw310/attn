import { useCallback, useRef } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { SnoozedThreadRow, ThreadRow } from '../../../shared/mail'
import type { MailView } from '../mailDisplay'
import {
  applyThreadFlag,
  applyThreadFlagToElement,
  rollbackThreadFlag,
  type ThreadFlagSnapshot,
  threadFlagSnapshot
} from '../optimisticTriage'
import type { MailboxRowCache } from './useMailData'

interface Options {
  selectedIds: ReadonlySet<string>
  selectedIndex: number
  threads: readonly { id: string; starred: boolean; unread: boolean }[]
  readerOpen: boolean
  view: MailView
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
  selectedThreadIdRef: React.RefObject<string | null>
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  setRealSnoozedThreads: React.Dispatch<React.SetStateAction<SnoozedThreadRow[] | null>>
  setMailboxRows: React.Dispatch<React.SetStateAction<MailboxRowCache>>
  updateSearchRows?: (updater: (rows: ThreadRow[]) => ThreadRow[]) => void
  clearSelection: () => void
  showToast: (message: string) => void
  setExitingThreadIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
}

function flagOwnerKey(threadId: string, field: ThreadFlagSnapshot['field']): string {
  return `${threadId}\0${field}`
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
    selectedRowRef,
    setRealThreads,
    setRealSnoozedThreads,
    setMailboxRows,
    updateSearchRows,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex
  } = options
  const flagOwnersRef = useRef(new Map<string, symbol>())
  const applyFlagToMailboxRows = useCallback(
    (snapshot: ThreadFlagSnapshot, rollback: boolean) => {
      setMailboxRows((current) => {
        let changed = false
        const next: MailboxRowCache = {}
        for (const [cachedView, rows] of Object.entries(current) as [string, ThreadRow[]][]) {
          const updated = rollback ? rollbackThreadFlag(rows, snapshot) : applyThreadFlag(rows, snapshot)
          if (updated !== rows) changed = true
          next[cachedView as keyof MailboxRowCache] = updated ?? rows
        }
        return changed ? next : current
      })
    },
    [setMailboxRows]
  )
  return useCallback(
    (action: TriageAction) => {
      if (!window.attn) return
      preserveSelectionOnRefreshRef.current = false
      const isBulk = selectedIds.size > 0
      const targetedAction = { ...action, threadIds: isBulk ? [...selectedIds] : action.threadIds }
      const flagSnapshot = threadFlagSnapshot(targetedAction, threads)
      const flagOwner = flagSnapshot ? Symbol('thread-flag-action') : null
      if (flagSnapshot && flagOwner) {
        for (const id of flagSnapshot.before.keys()) {
          flagOwnersRef.current.set(flagOwnerKey(id, flagSnapshot.field), flagOwner)
        }
        // The focused row changes in the same keydown turn. State keeps that
        // feedback declarative for every targeted row while SQLite catches up.
        applyThreadFlagToElement(selectedRowRef.current, flagSnapshot)
        setRealThreads((current) => applyThreadFlag(current, flagSnapshot))
        setRealSnoozedThreads((current) => applyThreadFlag(current, flagSnapshot))
        applyFlagToMailboxRows(flagSnapshot, false)
        updateSearchRows?.((rows) => applyThreadFlag(rows, flagSnapshot) ?? rows)
      }
      const settleFlag = (rollback: boolean): void => {
        if (!flagSnapshot || !flagOwner) return
        const ownedBefore = new Map<string, boolean>()
        for (const [id, before] of flagSnapshot.before) {
          const ownerKey = flagOwnerKey(id, flagSnapshot.field)
          if (flagOwnersRef.current.get(ownerKey) !== flagOwner) continue
          ownedBefore.set(id, before)
          flagOwnersRef.current.delete(ownerKey)
        }
        if (!rollback || ownedBefore.size === 0) return
        const ownedSnapshot = { ...flagSnapshot, before: ownedBefore }
        applyThreadFlagToElement(selectedRowRef.current, ownedSnapshot, true)
        setRealThreads((current) => rollbackThreadFlag(current, ownedSnapshot))
        setRealSnoozedThreads((current) => rollbackThreadFlag(current, ownedSnapshot))
        applyFlagToMailboxRows(ownedSnapshot, true)
        updateSearchRows?.((rows) => rollbackThreadFlag(rows, ownedSnapshot) ?? rows)
      }
      let selectionRollback: { fromId: string; toId: string | null } | null = null
      if (isBulk) clearSelection()
      if (action.kind === 'archive' && view === 'inbox' && !readerOpen) {
        // Give the focused row feedback before React projects the surviving
        // layout. That projection is deliberately comprehensive for bulk
        // actions and can take more than one frame in a 10,000-thread inbox.
        // The state update below immediately makes this DOM hint declarative.
        const selectedRow = selectedRowRef.current
        if (selectedRow && targetedAction.threadIds.includes(selectedRow.dataset.threadId ?? '')) {
          selectedRow.dataset.exiting = 'true'
          selectedRow.classList.add('app-thread-exit')
        }
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
        .then((result) => {
          settleFlag(false)
          showToast(result.label)
        })
        .catch(() => {
          settleFlag(true)
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
      applyFlagToMailboxRows,
      clearSelection,
      deferRefreshUntilRef,
      preserveSelectionOnRefreshRef,
      readerOpen,
      selectedIds,
      selectedIndex,
      selectedRowRef,
      selectedThreadIdRef,
      setExitingThreadIds,
      setRealSnoozedThreads,
      setRealThreads,
      setSelectedIndex,
      showToast,
      threads,
      updateSearchRows,
      view
    ]
  )
}
