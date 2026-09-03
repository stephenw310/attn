import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ThreadPageCursor, ThreadRow } from '../../../shared/mail'
import type { ComposerHandle } from '../composer/Composer'
import {
  type CachedThreadView,
  cachedThreadView,
  type MailView,
  type NavigableMailView,
  type PagedThreadView
} from '../mailDisplay'
import { conversationMailboxFor } from '../searchView'
import type { ThreadPagination, ThreadPaginationState } from './useMailData'
import { useRestoreTarget } from './useRestoreTarget'
import type { SplitData } from './useSplits'
import type { ViewRecordStore } from './useViewRecords'

const EMPTY_RECORD = { rowId: null, index: 0, scrollTop: 0 }

interface RowId {
  id: string
}

interface Options {
  view: MailView
  /** The synchronous half of `view`; `applyView` is the only writer of both. */
  viewRef: React.RefObject<MailView>
  applyView: (next: MailView) => void
  records: ViewRecordStore
  splits: SplitData
  /** The mounted inline reply, if any: a view change saves and closes it first. */
  inlineComposerRef: React.RefObject<ComposerHandle | null>
  searchOpenRef: React.RefObject<boolean>
  /** Leave search without restoring anything — the caller owns the restore. */
  closeSearch: () => void
  /** True once the view's rows are in state and their order is final. */
  viewRowsLoaded: boolean
  threads: readonly RowId[]
  mailboxThreads: readonly RowId[]
  realThreads: ThreadRow[] | null
  realDrafts: readonly RowId[]
  realOutbox: readonly RowId[]
  pagedView: PagedThreadView | null
  activePageState: ThreadPaginationState | undefined
  threadPagination: ThreadPagination
  loadMoreThreads: (view: PagedThreadView) => Promise<void>
  loadedInboxSplitId: string | null
  loadedInboxSplitStale: boolean
  activateInboxSplitCache: (splitId: string) => void
  inboxSplitRevision: number | undefined
  mailRevision: number
  selectedIndex: number
  readerOpen: boolean
  clearSelection: () => void
  invalidateConversations: () => void
  refreshCachedThreadView: (view: CachedThreadView) => Promise<void>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  setReaderOpen: (open: boolean) => void
  /** The snooze and label pickers hang off the focused row; navigation drops them. */
  closePickers: () => void
  closeMove: () => void
  closeSettings: () => void
  setDetachedDraftThread: (thread: null) => void
  listElRef: React.RefObject<HTMLElement | null>
  selectedIndexRef: React.RefObject<number>
  readerOpenRef: React.RefObject<boolean>
  selectedThreadIdRef: React.RefObject<string | null>
  selectedDraftIdRef: React.RefObject<string | null>
}

export interface ViewNavigation {
  /** Switch mailbox, saving and closing a mounted inline reply first (F6). */
  switchView: (next: NavigableMailView, afterSwitch?: () => void) => void
  switchSplit: (id: string) => void
  moveSplit: (direction: -1 | 1) => void
  openOutbox: () => void
  closeOutbox: () => void
  /** Cancel both queued restores — a notification target owns the selection. */
  cancelPendingRestores: () => void
}

/**
 * Mailbox, split and outbox navigation, and the restore machinery behind it
 * (F3, F18): every switch saves the list it leaves and queues the record for
 * the list it enters, and the two layout effects below apply that record once
 * the entered view's rows have loaded — paging up to the saved extent first,
 * and confirming with a targeted read before paging past it.
 */
export function useViewNavigation(options: Options): ViewNavigation {
  const latest = useRef(options)
  latest.current = options
  const {
    view,
    viewRowsLoaded,
    threads,
    realThreads,
    realDrafts,
    realOutbox,
    pagedView,
    activePageState,
    threadPagination,
    loadMoreThreads,
    loadedInboxSplitId,
    loadedInboxSplitStale,
    inboxSplitRevision,
    mailRevision,
    records,
    splits
  } = options

  const switchViewNow = useCallback((next: NavigableMailView) => {
    const options = latest.current
    const { records, viewRef, searchOpenRef, selectedThreadIdRef, selectedDraftIdRef } = options
    const previous = viewRef.current
    const wasSearching = searchOpenRef.current
    if (!wasSearching && previous !== next) records.saveActiveViewRecord()
    const record =
      wasSearching && previous === next
        ? (records.searchReturn.current ?? EMPTY_RECORD)
        : (records.viewRecords.current.get(next) ?? EMPTY_RECORD)
    if (wasSearching) {
      records.searchReturn.current = null
      options.closeSearch()
    }
    selectedDraftIdRef.current = next === 'drafts' ? record.rowId : null
    selectedThreadIdRef.current = next === 'drafts' ? null : record.rowId
    records.pendingViewRestore.current = { view: next, record }
    // Reader projections differ per mailbox: a Trash reader must never reuse
    // an All Mail conversation, so drop the cache when the projection changes.
    if (conversationMailboxFor(previous) !== conversationMailboxFor(next)) options.invalidateConversations()
    const target = cachedThreadView(next)
    if (target) void options.refreshCachedThreadView(target).catch(() => {})
    options.clearSelection()
    options.applyView(next)
    options.setSelectedIndex(Math.max(0, record.index))
    options.setReaderOpen(false)
    options.closePickers()
    options.closeMove()
    options.setDetachedDraftThread(null)
    options.closeSettings()
  }, [])

  // A mounted inline reply owns the conversation it sits in: it saves and
  // closes itself before the list beneath it changes. The ref alone answers
  // whether one is mounted — it is attached by the same render that shows it.
  const switchView = useCallback(
    (next: NavigableMailView, afterSwitch?: () => void) => {
      const inline = latest.current.inlineComposerRef.current
      if (inline) {
        inline.exitConversation(() => {
          switchViewNow(next)
          afterSwitch?.()
        })
        return
      }
      switchViewNow(next)
      afterSwitch?.()
    },
    [switchViewNow]
  )

  const switchSplit = useCallback(
    (id: string) => {
      const options = latest.current
      const { records, splits, viewRef, searchOpenRef, selectedIndexRef, readerOpenRef } = options
      const { selectedThreadIdRef, selectedDraftIdRef, listElRef, mailboxThreads } = options
      const splitState = splits.state
      if (!splitState?.splits.some((split) => split.id === id)) return
      const currentId = splits.activeSplitId
      const inInbox = !searchOpenRef.current && viewRef.current === 'inbox'
      if (inInbox && currentId === id) return
      if (inInbox && currentId) {
        records.splitRecords.current.set(currentId, {
          // Read the selected row from this render. The mirror ref updates in a
          // passive effect and can still point at the previous row if a user
          // presses J and immediately clicks another split.
          rowId: mailboxThreads[selectedIndexRef.current]?.id ?? selectedThreadIdRef.current,
          index: selectedIndexRef.current,
          loadedRows: mailboxThreads.length,
          scrollTop: readerOpenRef.current
            ? (records.splitRecords.current.get(currentId)?.scrollTop ?? 0)
            : (listElRef.current?.scrollTop ?? 0)
        })
      }
      if (viewRef.current !== 'inbox' || searchOpenRef.current) switchViewNow('inbox')
      const record = records.splitRecords.current.get(id) ?? EMPTY_RECORD
      records.pendingSplitRestore.current = { id, record }
      selectedThreadIdRef.current = record.rowId
      selectedDraftIdRef.current = null
      options.clearSelection()
      options.setReaderOpen(false)
      options.closePickers()
      options.setSelectedIndex(Math.max(0, record.index))
      options.activateInboxSplitCache(id)
      splits.setActiveSplitId(id)
    },
    [switchViewNow]
  )

  const moveSplit = useCallback(
    (direction: -1 | 1) => {
      const { splits } = latest.current
      const splitState = splits.state
      const currentId = splits.activeSplitId
      if (!splitState || !currentId) return
      const current = splitState.splits.findIndex((split) => split.id === currentId)
      if (current < 0) return
      const next = (current + direction + splitState.splits.length) % splitState.splits.length
      switchSplit(splitState.splits[next].id)
    },
    [switchSplit]
  )

  const pendingThreadRestore =
    view === 'inbox' && records.pendingSplitRestore.current?.id === splits.activeSplitId
      ? records.pendingSplitRestore.current.record
      : records.pendingViewRestore.current?.view === view
        ? records.pendingViewRestore.current.record
        : null
  const missingRestoreTarget =
    viewRowsLoaded &&
    pagedView &&
    activePageState?.nextCursor &&
    pendingThreadRestore?.rowId &&
    threads.length >= (pendingThreadRestore.loadedRows ?? pendingThreadRestore.index + 1) &&
    !threads.some((thread) => thread.id === pendingThreadRestore.rowId)
      ? pendingThreadRestore.rowId
      : null
  const restoreTargetPresent = useRestoreTarget(
    pagedView,
    missingRestoreTarget,
    (activePageState?.nextCursor ?? null) as ThreadPageCursor | null,
    view === 'inbox' ? splits.activeSplitId : null,
    view === 'inbox' ? inboxSplitRevision : undefined,
    mailRevision
  )

  // Restore the returning view's selection and scroll once its rows are in
  // state. Selection follows the thread id first — refreshed rows may have
  // moved it — and falls back to the clamped index when the thread left the
  // view. ThreadList's follow-scroll then keeps the row visible if the two
  // restored halves disagree.
  useLayoutEffect(() => {
    const { records, selectedThreadIdRef, selectedDraftIdRef, listElRef, setSelectedIndex } = latest.current
    const pending = records.pendingViewRestore.current
    if (!pending || pending.view !== view || !viewRowsLoaded) return
    const record = pending.record
    const rowIds =
      view === 'drafts'
        ? realDrafts.map((draft) => draft.id)
        : view === 'outbox'
          ? realOutbox.map((item) => item.id)
          : threads.map((thread) => thread.id)
    const restoredIndex = record.rowId ? rowIds.indexOf(record.rowId) : -1
    // Drafts have no loaded/empty sentinel: a freshly remounted tree renders
    // an empty list before the first read lands. Hold a restore that expects
    // rows until they arrive rather than consuming it against nothing.
    if (view === 'drafts' && rowIds.length === 0 && (record.rowId !== null || record.index > 0)) return
    // A remount starts with one page. Reload up to the saved extent (for the
    // scroll offset and the selected row) before restoring. Beyond that extent,
    // only keep paging if a targeted read confirms the row still belongs here.
    if (pagedView && activePageState?.nextCursor && rowIds.length < (record.loadedRows ?? record.index + 1)) {
      void loadMoreThreads(pagedView)
      return
    }
    if (missingRestoreTarget && pagedView && restoreTargetPresent !== false) {
      if (restoreTargetPresent) void loadMoreThreads(pagedView)
      return
    }
    records.pendingViewRestore.current = null
    const nextIndex =
      restoredIndex >= 0 ? restoredIndex : Math.max(0, Math.min(record.index, rowIds.length - 1))
    const draftLikeView = view === 'drafts' || view === 'outbox'
    selectedDraftIdRef.current = draftLikeView ? (rowIds[nextIndex] ?? null) : null
    selectedThreadIdRef.current = draftLikeView ? null : (rowIds[nextIndex] ?? null)
    setSelectedIndex(nextIndex)
    const list = listElRef.current
    if (list) list.scrollTop = record.scrollTop
  }, [
    activePageState?.nextCursor,
    loadMoreThreads,
    missingRestoreTarget,
    pagedView,
    realDrafts,
    realOutbox,
    restoreTargetPresent,
    threads,
    view,
    viewRowsLoaded
  ])

  useLayoutEffect(() => {
    const { records, selectedThreadIdRef, listElRef, setSelectedIndex } = latest.current
    const pending = records.pendingSplitRestore.current
    // A restored split can have been deleted since the snapshot was taken;
    // drop the stale restore once the rules are known rather than waiting on
    // a split that will never activate.
    if (pending && splits.state && !splits.state.splits.some((split) => split.id === pending.id)) {
      records.pendingSplitRestore.current = null
      return
    }
    if (
      !pending ||
      view !== 'inbox' ||
      splits.activeSplitId !== pending.id ||
      loadedInboxSplitId !== pending.id ||
      loadedInboxSplitStale ||
      realThreads === null
    ) {
      return
    }
    const restoredIndex = pending.record.rowId
      ? realThreads.findIndex((thread) => thread.id === pending.record.rowId)
      : -1
    if (
      threadPagination.inbox?.nextCursor &&
      realThreads.length < (pending.record.loadedRows ?? pending.record.index + 1)
    ) {
      void loadMoreThreads('inbox')
      return
    }
    if (missingRestoreTarget && restoreTargetPresent !== false) {
      if (restoreTargetPresent) void loadMoreThreads('inbox')
      return
    }
    records.pendingSplitRestore.current = null
    const nextIndex =
      restoredIndex >= 0
        ? restoredIndex
        : Math.max(0, Math.min(pending.record.index, Math.max(0, realThreads.length - 1)))
    selectedThreadIdRef.current = realThreads[nextIndex]?.id ?? null
    setSelectedIndex(nextIndex)
    if (listElRef.current) listElRef.current.scrollTop = pending.record.scrollTop
  }, [
    loadedInboxSplitId,
    loadedInboxSplitStale,
    loadMoreThreads,
    missingRestoreTarget,
    realThreads,
    restoreTargetPresent,
    splits.activeSplitId,
    splits.state,
    threadPagination.inbox?.nextCursor,
    view
  ])

  const openOutboxNow = useCallback(() => {
    const options = latest.current
    const { records, viewRef, searchOpenRef, selectedThreadIdRef, selectedDraftIdRef } = options
    if (viewRef.current === 'outbox') {
      if (searchOpenRef.current) {
        const record = records.searchReturn.current ?? EMPTY_RECORD
        records.searchReturn.current = null
        options.closeSearch()
        records.pendingViewRestore.current = { view: 'outbox', record }
        selectedDraftIdRef.current = record.rowId
        selectedThreadIdRef.current = null
        options.setSelectedIndex(Math.max(0, record.index))
      }
      return
    }
    if (searchOpenRef.current) {
      records.searchReturn.current = null
      options.closeSearch()
    }
    records.outboxReturn.current = {
      view: viewRef.current as NavigableMailView,
      selectedIndex: options.selectedIndex,
      readerOpen: options.readerOpen
    }
    selectedDraftIdRef.current = null
    options.applyView('outbox')
    options.setSelectedIndex(0)
    options.setReaderOpen(false)
    options.closePickers()
    options.closeMove()
    options.closeSettings()
  }, [])

  const openOutbox = useCallback(() => {
    const options = latest.current
    if (options.viewRef.current === 'outbox' && !options.searchOpenRef.current) return
    const inline = options.inlineComposerRef.current
    if (inline) {
      inline.exitConversation(openOutboxNow)
      return
    }
    openOutboxNow()
  }, [openOutboxNow])

  const closeOutbox = useCallback(() => {
    const options = latest.current
    const previous = options.records.outboxReturn.current
    options.selectedDraftIdRef.current = null
    options.applyView(previous.view)
    options.setSelectedIndex(previous.selectedIndex)
    options.setReaderOpen(previous.readerOpen)
  }, [])

  const cancelPendingRestores = useCallback(() => {
    latest.current.records.pendingViewRestore.current = null
    latest.current.records.pendingSplitRestore.current = null
  }, [])

  return { switchView, switchSplit, moveSplit, openOutbox, closeOutbox, cancelPendingRestores }
}
