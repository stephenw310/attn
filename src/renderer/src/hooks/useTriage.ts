import { useCallback, useRef } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { SnoozedThreadRow, ThreadRow } from '../../../shared/mail'
import type { AutoAdvanceDirection } from '../../../shared/settings'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../../shared/splits'
import { type MailView, userLabelId } from '../mailDisplay'
import {
  applyThreadFlag,
  applyThreadFlagToElement,
  applyThreadMove,
  applyThreadMoveMembership,
  movedThreadIdsOutsideView,
  moveExitsView,
  rollbackThreadFlag,
  rollbackThreadMove,
  rollbackThreadMoveMembership,
  selectionAfterExit,
  type ThreadFlagSnapshot,
  type ThreadMoveSnapshot,
  threadFlagSnapshot,
  threadMoveSnapshot
} from '../optimisticTriage'
import type { MailboxRowCache } from './useMailData'

interface Options {
  selectedIds: ReadonlySet<string>
  selectedIndex: number
  threads: readonly {
    id: string
    from: string
    subject: string
    snippet: string
    lastMsgAt: number
    starred: boolean
    unread: boolean
    hasAttachment: boolean
    hasDraft: boolean
    labelIds: readonly string[]
    snoozed: boolean
    returned: boolean
  }[]
  readerOpen: boolean
  view: MailView
  activeSplitId: string | null
  searchOpen: boolean
  searchMoveRetains?: (thread: Options['threads'][number]) => boolean
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
  selectedThreadIdRef: React.RefObject<string | null>
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  realSnoozedThreads: SnoozedThreadRow[] | null
  setRealSnoozedThreads: React.Dispatch<React.SetStateAction<SnoozedThreadRow[] | null>>
  mailboxRows: MailboxRowCache
  setMailboxRows: React.Dispatch<React.SetStateAction<MailboxRowCache>>
  updateSearchRows?: (updater: (rows: ThreadRow[]) => ThreadRow[]) => void
  clearSelection: () => void
  showToast: (message: string) => void
  setExitingThreadIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  /** Where triage lands after removing the focused row (F3, F15 setting). */
  autoAdvance: AutoAdvanceDirection
  /** 'list' auto-advance: return the open reader to the full-width list. */
  closeReader: () => void
  /**
   * Undo a 'list' advance whose triage write was rejected outright: the
   * optimistic rollback restores the rows and selection, and this restores
   * the reader the advance closed (PR #101 review).
   */
  reopenReader: () => void
}

function flagOwnerKey(threadId: string, field: ThreadFlagSnapshot['field']): string {
  return `${threadId}\0${field}`
}

function moveRetainsCachedView(row: ThreadRow, view: MailView): boolean {
  if (view === 'inbox') {
    return row.labelIds.includes('INBOX') && !row.labelIds.includes('SPAM') && !row.labelIds.includes('TRASH')
  }
  if (view === 'snoozed') return row.snoozed
  if (view === 'spam') return row.labelIds.includes('SPAM')
  if (view === 'trash') return row.labelIds.includes('TRASH')
  if (row.labelIds.includes('SPAM') || row.labelIds.includes('TRASH')) return false
  if (view === 'allMail') return true
  if (view === 'sent') return row.labelIds.includes('SENT')
  if (view === 'starred') return row.labelIds.includes('STARRED')
  const labelId = userLabelId(view)
  return labelId !== null && row.labelIds.includes(labelId)
}

function moveRetainsActiveInboxSplit(row: ThreadRow, activeSplitId: string | null): boolean {
  if (!moveRetainsCachedView(row, 'inbox')) return false
  if (activeSplitId === IMPORTANT_SPLIT_ID) return row.labelIds.includes('IMPORTANT')
  if (activeSplitId === OTHER_SPLIT_ID) return !row.labelIds.includes('IMPORTANT')
  return true
}

/**
 * The rows a move can add to another cached view: only threads the move
 * touched, projected into the `ThreadRow` shape those caches hold.
 */
function moveCandidates(threads: Options['threads'], snapshot: ThreadMoveSnapshot): readonly ThreadRow[] {
  const candidates: ThreadRow[] = []
  for (const thread of threads) {
    if (!snapshot.before.has(thread.id)) continue
    candidates.push({
      id: thread.id,
      fromDisplay: thread.from,
      subject: thread.subject,
      snippet: thread.snippet,
      lastMsgAt: thread.lastMsgAt,
      unread: thread.unread,
      starred: thread.starred,
      hasAttachment: thread.hasAttachment,
      snoozed: thread.snoozed,
      returned: thread.returned,
      hasDraft: thread.hasDraft,
      labelIds: [...thread.labelIds]
    })
  }
  return candidates
}

export function useTriage(options: Options): (action: TriageAction) => void {
  const {
    selectedIds,
    selectedIndex,
    threads,
    readerOpen,
    view,
    activeSplitId,
    searchOpen,
    searchMoveRetains,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    selectedThreadIdRef,
    selectedRowRef,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    setRealSnoozedThreads,
    mailboxRows,
    setMailboxRows,
    updateSearchRows,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex,
    autoAdvance,
    closeReader,
    reopenReader
  } = options
  const flagOwnersRef = useRef(new Map<string, symbol>())
  const moveOwnersRef = useRef(new Map<string, symbol>())
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
  const applyMoveToMailboxRows = useCallback(
    (snapshot: ThreadMoveSnapshot, preservedView: MailView | null, candidates: readonly ThreadRow[]) => {
      setMailboxRows((current) => {
        let changed = false
        const next: MailboxRowCache = {}
        for (const [cachedView, rows] of Object.entries(current) as [string, ThreadRow[]][]) {
          const preservedIds =
            cachedView === preservedView ? new Set(snapshot.before.keys()) : new Set<string>()
          let updated = applyThreadMoveMembership(
            rows,
            snapshot,
            (row) => moveRetainsCachedView(row, cachedView as MailView),
            preservedIds
          )
          const existingIds = new Set((updated ?? []).map((row) => row.id))
          const movedCandidates = applyThreadMove([...candidates], snapshot) ?? []
          const additions = movedCandidates.filter(
            (row) =>
              snapshot.before.has(row.id) &&
              !existingIds.has(row.id) &&
              moveRetainsCachedView(row, cachedView as MailView)
          )
          if (additions.length > 0) {
            updated = [...(updated ?? []), ...additions].sort(
              (left, right) => right.lastMsgAt - left.lastMsgAt || left.id.localeCompare(right.id)
            )
          }
          if (updated !== rows) changed = true
          next[cachedView as keyof MailboxRowCache] = updated ?? rows
        }
        return changed ? next : current
      })
    },
    [setMailboxRows]
  )
  const rollbackMoveInMailboxRows = useCallback(
    (snapshot: ThreadMoveSnapshot, beforeRows: MailboxRowCache) => {
      setMailboxRows((current) => {
        let changed = false
        const next: MailboxRowCache = {}
        for (const [cachedView, rows] of Object.entries(current) as [string, ThreadRow[]][]) {
          const updated = rollbackThreadMoveMembership(rows, beforeRows[cachedView] ?? null, snapshot)
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
      const isBulk = selectedIds.size > 0 || (action.kind === 'move' && action.threadIds.length > 1)
      const targetedAction: TriageAction =
        action.kind === 'move'
          ? action
          : { ...action, threadIds: selectedIds.size > 0 ? [...selectedIds] : action.threadIds }
      const flagSnapshot = threadFlagSnapshot(targetedAction, threads)
      const moveSnapshot = threadMoveSnapshot(targetedAction, threads)
      const moveCacheBefore = moveSnapshot ? { realThreads, realSnoozedThreads, mailboxRows } : null
      const flagOwner = flagSnapshot ? Symbol('thread-flag-action') : null
      const moveOwner = moveSnapshot ? Symbol('thread-move-action') : null
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
      if (moveSnapshot && moveOwner) {
        for (const id of moveSnapshot.before.keys()) moveOwnersRef.current.set(id, moveOwner)
        const preservedView = searchOpen ? null : view
        const preservedIds = new Set(moveSnapshot.before.keys())
        setRealThreads((current) =>
          applyThreadMoveMembership(
            current,
            moveSnapshot,
            (row) => moveRetainsActiveInboxSplit(row, activeSplitId),
            preservedView === 'inbox' ? preservedIds : undefined
          )
        )
        setRealSnoozedThreads((current) =>
          applyThreadMoveMembership(
            current,
            moveSnapshot,
            (row) => moveRetainsCachedView(row, 'snoozed'),
            preservedView === 'snoozed' ? preservedIds : undefined
          )
        )
        // Only rows the move touched can be added to another cached view, so
        // the candidate list is built here from the moved ids rather than
        // maintaining a full copy of the visible list on every list change.
        applyMoveToMailboxRows(moveSnapshot, preservedView, moveCandidates(threads, moveSnapshot))
        updateSearchRows?.((rows) => applyThreadMove(rows, moveSnapshot) ?? rows)
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
      const settleMove = (rollback: boolean): void => {
        if (!moveSnapshot || !moveOwner) return
        const ownedBefore = new Map(moveSnapshot.before)
        ownedBefore.clear()
        for (const [id, before] of moveSnapshot.before) {
          if (moveOwnersRef.current.get(id) !== moveOwner) continue
          ownedBefore.set(id, before)
          moveOwnersRef.current.delete(id)
        }
        if (!rollback || ownedBefore.size === 0) return
        const ownedSnapshot = { ...moveSnapshot, before: ownedBefore }
        setRealThreads((current) =>
          rollbackThreadMoveMembership(current, moveCacheBefore?.realThreads ?? null, ownedSnapshot)
        )
        setRealSnoozedThreads((current) =>
          rollbackThreadMoveMembership(current, moveCacheBefore?.realSnoozedThreads ?? null, ownedSnapshot)
        )
        rollbackMoveInMailboxRows(ownedSnapshot, moveCacheBefore?.mailboxRows ?? {})
        updateSearchRows?.((rows) => rollbackThreadMove(rows, ownedSnapshot) ?? rows)
      }
      let selectionRollback: { fromId: string; toId: string | null } | null = null
      let closedReaderForAdvance = false
      if (isBulk) clearSelection()
      const exitingThreadIds =
        targetedAction.kind === 'archive' && view === 'inbox'
          ? targetedAction.threadIds
          : moveSnapshot
            ? searchOpen && searchMoveRetains
              ? movedThreadIdsOutsideView(threads, moveSnapshot, searchMoveRetains)
              : moveExitsView(targetedAction, view, activeSplitId)
                ? targetedAction.threadIds
                : []
            : []
      if (exitingThreadIds.length > 0 && !readerOpen) {
        // Give the focused row feedback before React projects the surviving
        // layout. That projection is deliberately comprehensive for bulk
        // actions and can take more than one frame in a 10,000-thread inbox.
        // The state update below immediately makes this DOM hint declarative.
        const selectedRow = selectedRowRef.current
        if (selectedRow && exitingThreadIds.includes(selectedRow.dataset.threadId ?? '')) {
          selectedRow.dataset.exiting = 'true'
          selectedRow.classList.add('app-thread-exit')
        }
        setExitingThreadIds((current) => new Set([...current, ...exitingThreadIds]))
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550
        deferRefreshUntilRef.current = Math.max(deferRefreshUntilRef.current, Date.now() + duration)
        // 'list' only distinguishes the reader; in the list it means 'next'.
        const selection = selectionAfterExit(
          threads,
          exitingThreadIds,
          selectedIndex,
          autoAdvance === 'previous' ? 'previous' : 'next'
        )
        if (selection) {
          selectionRollback = { fromId: selection.fromId, toId: selection.toId }
          selectedThreadIdRef.current = selection.toId
          preserveSelectionOnRefreshRef.current = selection.toId !== null
          setSelectedIndex(Math.max(0, selection.nextIndex))
        }
      } else if (exitingThreadIds.length > 0 && readerOpen && autoAdvance !== 'next') {
        // The reader's default advance is free: the removed row's successor
        // slides into the same index on refresh. The other two directions
        // retarget before the refresh lands (F3 auto-advance setting).
        if (autoAdvance === 'list') {
          closedReaderForAdvance = true
          closeReader()
        } else {
          const selection = selectionAfterExit(threads, exitingThreadIds, selectedIndex, 'previous')
          if (selection && selection.toId !== null && selection.toId !== selection.fromId) {
            selectionRollback = { fromId: selection.fromId, toId: selection.toId }
            selectedThreadIdRef.current = selection.toId
            preserveSelectionOnRefreshRef.current = true
            setSelectedIndex(Math.max(0, selection.nextIndex))
          }
        }
      }
      void window.attn.mail
        .triage(targetedAction)
        .then((result) => {
          settleFlag(false)
          settleMove(false)
          showToast(result.label)
        })
        .catch(() => {
          settleFlag(true)
          settleMove(true)
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
            for (const id of exitingThreadIds) next.delete(id)
            return next
          })
          // A rejected write rolled the action back entirely; the reader the
          // 'list' advance closed comes back with it.
          if (closedReaderForAdvance) reopenReader()
        })
    },
    [
      applyFlagToMailboxRows,
      applyMoveToMailboxRows,
      activeSplitId,
      autoAdvance,
      clearSelection,
      closeReader,
      reopenReader,
      deferRefreshUntilRef,
      preserveSelectionOnRefreshRef,
      readerOpen,
      realSnoozedThreads,
      realThreads,
      mailboxRows,
      rollbackMoveInMailboxRows,
      searchMoveRetains,
      searchOpen,
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
