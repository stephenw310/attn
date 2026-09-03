import { useCallback, useRef } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel } from '../../../shared/mail'
import type { MoveDestination } from '../../../shared/move'
import type { AutoAdvanceDirection } from '../../../shared/settings'
import type { ComposerHandle } from '../composer/Composer'
import type { LabelCheckState } from '../LabelPicker'
import type { MoveTarget } from '../MovePicker'
import { type DisplayThread, type MailView, userLabelId } from '../mailDisplay'
import { selectionAfterExit } from '../optimisticTriage'
import type { ShowToast } from './useToast'
import type { ViewRecordStore } from './useViewRecords'

export interface MoveRequest {
  targets: readonly MoveTarget[]
  sourceLabelId: string | null
}

interface Options {
  view: MailView
  searchOpen: boolean
  /** `in:drafts` search results are draft rows, not threads. */
  searchDraftMode: boolean
  searchDrafts: readonly Draft[]
  threads: readonly DisplayThread[]
  realDrafts: readonly { id: string }[]
  realOutbox: readonly { id: string }[]
  selectedIndex: number
  selected: DisplayThread | undefined
  selectedIds: ReadonlySet<string>
  /** The threads a verb acts on: the whole selection, or the focused row. */
  targetedThreads: readonly DisplayThread[]
  detachedDraftThread: DisplayThread | null
  readerOpen: boolean
  moveAllowed: boolean
  autoAdvance: AutoAdvanceDirection
  /** Ids snapshotted when the label picker opened, resolved to threads. */
  labelTargets: readonly DisplayThread[] | undefined
  moveRequest: MoveRequest | null
  triage: (action: TriageAction) => void
  records: ViewRecordStore
  inlineComposerRef: React.RefObject<ComposerHandle | null>
  listElRef: React.RefObject<HTMLElement | null>
  selectedThreadIdRef: React.RefObject<string | null>
  setSelectedIndex: (index: number) => void
  setReaderOpen: (open: boolean) => void
  setSnoozeOpen: (open: boolean) => void
  setLabelTargetIds: (ids: readonly string[] | null) => void
  setMoveRequest: (request: MoveRequest | null) => void
  setDetachedDraftThread: (thread: DisplayThread | null) => void
  finishReaderClose: () => void
  clearSelection: () => void
  reopenDraftForThread: (threadId: string) => void
  reopenListDraft: (draftId: string) => void
  openOutboxItem: (index: number) => void
  focusSearchResults: () => void
  showToast: ShowToast
}

export interface ListActions {
  openSelected: () => void
  openThread: (index: number) => void
  /** A row click in search also moves the keyboard focus onto the results. */
  openThreadFromList: (index: number) => void
  navigateNext: () => void
  navigatePrevious: () => void
  closeReader: () => void
  openSnooze: () => void
  openLabel: () => void
  openMove: () => void
  moveSelected: (destination: MoveDestination) => void
  markNotDone: () => void
  snoozeSelected: (dueAt: number) => void
  unsnoozeSelected: () => void
  toggleLabel: (label: MailLabel, state: LabelCheckState) => void
}

/**
 * What the keys and the pointer do to the visible list: open, navigate, and
 * the triage verbs that need a target. Every one reads the cursor, the list and
 * the selection when it runs, through one render-time mirror — the ~60-command
 * batch is registered on these callbacks, and rebuilding it on each J/K would
 * notify the footer, the palette and the cheat sheet with it (P1).
 */
export function useListActions(options: Options): ListActions {
  const latest = useRef(options)
  latest.current = options

  const toggleLabel = useCallback((label: MailLabel, state: LabelCheckState) => {
    const { labelTargets, triage } = latest.current
    if (!labelTargets) return
    triage({
      kind: 'label',
      threadIds: labelTargets.map((target) => target.id),
      add: state === 'all' ? [] : [label.id],
      remove: state === 'all' ? [label.id] : []
    })
  }, [])

  const noteRowOpened = useCallback((rowId: string, index: number) => {
    const { records, view, listElRef } = latest.current
    records.viewRecords.current.set(view, {
      rowId,
      index,
      scrollTop: listElRef.current?.scrollTop ?? 0
    })
  }, [])

  const openSelected = useCallback(() => {
    const options = latest.current
    const { searchOpen, view, selectedIndex, threads } = options
    if (options.searchDraftMode) {
      const draft = options.searchDrafts[selectedIndex]
      if (!draft) return
      options.reopenListDraft(draft.id)
      return
    }
    if (!searchOpen && view === 'outbox') {
      options.openOutboxItem(selectedIndex)
      return
    }
    if (!searchOpen && view === 'drafts') {
      const draft = options.realDrafts[selectedIndex]
      if (!draft) return
      options.reopenListDraft(draft.id)
      return
    }
    const thread = threads[selectedIndex]
    if (!thread) return
    if (!searchOpen) noteRowOpened(thread.id, selectedIndex)
    options.selectedThreadIdRef.current = thread.id
    options.setReaderOpen(true)
    options.reopenDraftForThread(thread.id)
  }, [noteRowOpened])

  const closeReader = useCallback(() => {
    const options = latest.current
    const inline = options.inlineComposerRef.current
    if (inline) {
      inline.exitConversation()
      return
    }
    options.finishReaderClose()
  }, [])

  const openSnooze = useCallback(() => {
    const { selected, setSnoozeOpen } = latest.current
    if (selected) setSnoozeOpen(true)
  }, [])

  const openLabel = useCallback(() => {
    const { selected, selectedIds, setLabelTargetIds } = latest.current
    if (!selected) return
    setLabelTargetIds(selectedIds.size > 0 ? [...selectedIds] : [selected.id])
  }, [])

  const openMove = useCallback(() => {
    const options = latest.current
    if (!options.selected || !options.moveAllowed) return
    options.setMoveRequest({
      targets: options.targetedThreads.map((thread) => ({
        id: thread.id,
        labelIds: [...thread.labelIds],
        snoozed: thread.snoozed,
        returned: thread.returned
      })),
      sourceLabelId: options.searchOpen ? null : userLabelId(options.view)
    })
  }, [])

  const moveSelected = useCallback((destination: MoveDestination) => {
    const { moveRequest, setMoveRequest, triage } = latest.current
    if (!moveRequest) return
    setMoveRequest(null)
    triage({
      kind: 'move',
      threadIds: moveRequest.targets.map((target) => target.id),
      destination,
      sourceLabelId: moveRequest.sourceLabelId
    })
  }, [])

  const markNotDone = useCallback(() => {
    const { selected, selectedIds, triage } = latest.current
    if (!selected) return
    triage({
      kind: 'move',
      threadIds: selectedIds.size > 0 ? [...selectedIds] : [selected.id],
      destination: { kind: 'inbox' },
      sourceLabelId: null,
      verb: 'markNotDone'
    })
  }, [])

  const openThread = useCallback(
    (index: number) => {
      const options = latest.current
      const thread = options.threads[index]
      if (!thread) return
      // Opening unread mail can immediately broadcast a mark-read refresh. Pin
      // the identity before that refresh starts; the effect that mirrors index
      // changes is deliberately too late for this transition.
      options.selectedThreadIdRef.current = thread.id
      if (!options.searchOpen) noteRowOpened(thread.id, index)
      options.setDetachedDraftThread(null)
      options.setSelectedIndex(index)
      options.setReaderOpen(true)
      options.reopenDraftForThread(thread.id)
    },
    [noteRowOpened]
  )

  const openThreadFromList = useCallback(
    (index: number) => {
      if (latest.current.searchOpen) latest.current.focusSearchResults()
      openThread(index)
    },
    [openThread]
  )

  const snoozeSelected = useCallback((dueAt: number) => {
    const options = latest.current
    const { selected, selectedIds, threads, selectedIndex, view, searchOpen, autoAdvance } = options
    if (!window.attn || !selected) return
    const isBulk = selectedIds.size > 0
    const threadIds = isBulk ? [...selectedIds] : [selected.id]
    options.setSnoozeOpen(false)
    if (isBulk) options.clearSelection()
    // Snooze removes rows on refresh rather than optimistically, so the
    // default 'next' advance is free (index preservation). The other two
    // directions retarget before the refresh lands (F3 auto-advance).
    if (!searchOpen && view !== 'snoozed') {
      if (options.readerOpen && autoAdvance === 'list') options.finishReaderClose()
      else if (autoAdvance === 'previous') {
        const selection = selectionAfterExit(threads, threadIds, selectedIndex, 'previous')
        if (selection && selection.toId !== null && selection.toId !== selection.fromId) {
          options.selectedThreadIdRef.current = selection.toId
          options.setSelectedIndex(Math.max(0, selection.nextIndex))
        }
      }
    }
    void window.attn.mail
      .snooze(threadIds, dueAt)
      .then((result) => latest.current.showToast(result.label))
      .catch(() => {})
  }, [])

  const unsnoozeSelected = useCallback(() => {
    const { selected, setSnoozeOpen, triage } = latest.current
    if (!selected) return
    setSnoozeOpen(false)
    triage({ kind: 'unsnooze', threadIds: [selected.id] })
  }, [])

  // While reading, J/K opens the next/previous conversation at its newest
  // message or restored draft (SPEC §5) — the same entry point Enter and a row
  // click use, so a Draft chip behaves identically however the row is reached.
  const readNextThread = useCallback((index: number) => {
    const options = latest.current
    const { view, searchOpen } = options
    if (!options.readerOpen || (!searchOpen && (view === 'drafts' || view === 'outbox'))) return
    const thread = options.threads[index]
    if (!thread) return
    options.selectedThreadIdRef.current = thread.id
    options.reopenDraftForThread(thread.id)
  }, [])

  const visibleRowCount = useCallback((): number => {
    const { searchDraftMode, searchDrafts, searchOpen, threads, view, realDrafts, realOutbox } =
      latest.current
    if (searchDraftMode) return searchDrafts.length
    if (searchOpen) return threads.length
    if (view === 'drafts') return realDrafts.length
    if (view === 'outbox') return realOutbox.length
    return threads.length
  }, [])

  const navigateNext = useCallback(() => {
    const options = latest.current
    if (options.detachedDraftThread) {
      options.finishReaderClose()
      return
    }
    const selectedIndex = options.selectedIndex
    const next = Math.min(selectedIndex + 1, Math.max(visibleRowCount() - 1, 0))
    options.setSelectedIndex(next)
    if (next !== selectedIndex) readNextThread(next)
  }, [readNextThread, visibleRowCount])

  const navigatePrevious = useCallback(() => {
    const options = latest.current
    if (options.detachedDraftThread) {
      options.finishReaderClose()
      return
    }
    const selectedIndex = options.selectedIndex
    if (options.readerOpen && selectedIndex === 0) {
      closeReader()
      return
    }
    const previous = Math.max(selectedIndex - 1, 0)
    options.setSelectedIndex(previous)
    if (previous !== selectedIndex) readNextThread(previous)
  }, [closeReader, readNextThread])

  return {
    openSelected,
    openThread,
    openThreadFromList,
    navigateNext,
    navigatePrevious,
    closeReader,
    openSnooze,
    openLabel,
    openMove,
    moveSelected,
    markNotDone,
    snoozeSelected,
    unsnoozeSelected,
    toggleLabel
  }
}
