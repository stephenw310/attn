import { useCallback, useMemo, useRef } from 'react'
import {
  type AccountViewSnapshot,
  saveAccountView,
  type ViewRecordSnapshot as ViewRecord
} from '../accountViewMemory'
import type { MailView, NavigableMailView } from '../list/mailDisplay'

/** Where the outbox returns to when it closes: the list it covered (F3). */
export interface OutboxReturn {
  view: NavigableMailView
  selectedIndex: number
  readerOpen: boolean
}

interface Options {
  /** Normalized active account id; null disables the account snapshot. */
  account: string | null
  /** The previous visit's snapshot for this account, read once at mount (F18). */
  restored: AccountViewSnapshot | null
  view: React.RefObject<MailView>
  searchOpen: React.RefObject<boolean>
  readerOpen: React.RefObject<boolean>
  activeSplitId: React.RefObject<string | null>
  listEl: React.RefObject<HTMLElement | null>
  selectedIndex: React.RefObject<number>
  selectedThreadId: React.RefObject<string | null>
  selectedDraftId: React.RefObject<string | null>
  loadedRows: React.RefObject<number>
}

export interface ViewRecordStore {
  /** Per-view selection and scroll; the split map is Inbox's per-split half. */
  viewRecords: React.RefObject<Map<MailView, ViewRecord>>
  splitRecords: React.RefObject<Map<string, ViewRecord>>
  /** A restore waiting for its view's rows to load; consumed by the layout effects. */
  pendingViewRestore: React.RefObject<{ view: MailView; record: ViewRecord } | null>
  pendingSplitRestore: React.RefObject<{ id: string; record: ViewRecord } | null>
  /** The pre-search state, stashed while search covers the list. */
  searchReturn: React.RefObject<ViewRecord | null>
  outboxReturn: React.RefObject<OutboxReturn>
  /** The cursor and scroll offset on screen right now. */
  captureRecord: () => ViewRecord
  /** Store `captureRecord()` for the active view, keeping a hidden list's offset. */
  saveActiveViewRecord: () => void
  /** Everything a warm return to this account restores (F18). */
  saveAccountSnapshot: () => void
}

const EMPTY_RECORD: ViewRecord = { rowId: null, index: 0, scrollTop: 0 }

/**
 * The F18 memory: which view, split, row and scroll offset each account was
 * last looking at. Navigation writes records, the restore layout effects read
 * them, and a guarded account switch persists the lot before the tree remounts.
 * It is a store, not a policy — every decision about when to restore lives in
 * useViewNavigation and useSearchSession, which both read this one map.
 */
export function useViewRecords(options: Options): ViewRecordStore {
  const { restored } = options
  const latest = useRef(options)
  latest.current = options

  const viewRecords = useRef(new Map<MailView, ViewRecord>(restored?.viewRecords ?? []))
  const splitRecords = useRef(new Map<string, ViewRecord>(restored?.splitRecords ?? []))
  // Cross-account restore rides the same pending-restore machinery a
  // same-account view switch uses: prime it at mount and the layout effects
  // apply selection and scroll once the restored view's rows load.
  const pendingSplitRestore = useRef<{ id: string; record: ViewRecord } | null>(
    restored?.view === 'inbox' && restored.splitId
      ? {
          id: restored.splitId,
          record: new Map(restored.splitRecords).get(restored.splitId) ?? EMPTY_RECORD
        }
      : null
  )
  const pendingViewRestore = useRef<{ view: MailView; record: ViewRecord } | null>(
    restored && (restored.view !== 'inbox' || !restored.splitId)
      ? { view: restored.view, record: new Map(restored.viewRecords).get(restored.view) ?? EMPTY_RECORD }
      : null
  )
  const searchReturn = useRef<ViewRecord | null>(null)
  const outboxReturn = useRef<OutboxReturn>({ view: 'inbox', selectedIndex: 0, readerOpen: false })

  const captureRecord = useCallback((): ViewRecord => {
    const { view, listEl, selectedIndex, selectedThreadId, selectedDraftId } = latest.current
    const draftLikeView = view.current === 'drafts' || view.current === 'outbox'
    return {
      rowId: draftLikeView ? selectedDraftId.current : selectedThreadId.current,
      index: selectedIndex.current,
      scrollTop: listEl.current?.scrollTop ?? 0
    }
  }, [])

  const saveActiveViewRecord = useCallback(() => {
    const { view, readerOpen, listEl, selectedIndex, selectedThreadId, selectedDraftId, loadedRows } =
      latest.current
    const current = view.current
    if (current === 'outbox') return
    // While the reader is open the list is display:none and reads scrollTop 0;
    // keep the last visible offset instead of clobbering it.
    const scrollTop = readerOpen.current
      ? (viewRecords.current.get(current)?.scrollTop ?? 0)
      : (listEl.current?.scrollTop ?? 0)
    viewRecords.current.set(current, {
      rowId: current === 'drafts' ? selectedDraftId.current : selectedThreadId.current,
      index: selectedIndex.current,
      scrollTop,
      loadedRows: loadedRows.current
    })
  }, [])

  // While search is open the live selection and scroll describe the *search*
  // list, so the records take the pre-search state `openSearch` stashed
  // instead — mirroring the `!wasSearching` guard in switchViewNow.
  const saveAccountSnapshot = useCallback(() => {
    const { account, view, searchOpen, readerOpen, activeSplitId, listEl, selectedIndex } = latest.current
    const { selectedThreadId, loadedRows } = latest.current
    if (!account) return
    const searching = searchOpen.current
    const returnRecord = searchReturn.current
    const rawView = view.current
    if (!searching) saveActiveViewRecord()
    else if (returnRecord && rawView !== 'outbox') {
      viewRecords.current.set(rawView, { ...returnRecord, loadedRows: loadedRows.current })
    }
    const currentSplitId = activeSplitId.current
    if (rawView === 'inbox' && currentSplitId) {
      if (!searching) {
        splitRecords.current.set(currentSplitId, {
          rowId: selectedThreadId.current,
          index: selectedIndex.current,
          loadedRows: loadedRows.current,
          scrollTop: readerOpen.current
            ? (splitRecords.current.get(currentSplitId)?.scrollTop ?? 0)
            : (listEl.current?.scrollTop ?? 0)
        })
      } else if (returnRecord) {
        splitRecords.current.set(currentSplitId, { ...returnRecord, loadedRows: loadedRows.current })
      }
    }
    saveAccountView(account, {
      view: rawView === 'outbox' ? outboxReturn.current.view : rawView,
      splitId: currentSplitId,
      viewRecords: [...viewRecords.current],
      splitRecords: [...splitRecords.current]
    })
  }, [saveActiveViewRecord])

  // The shell threads these into memoized callbacks and into the command
  // batch, so the store keeps one identity for the life of the mount.
  return useMemo(
    () => ({
      viewRecords,
      splitRecords,
      pendingViewRestore,
      pendingSplitRestore,
      searchReturn,
      outboxReturn,
      captureRecord,
      saveActiveViewRecord,
      saveAccountSnapshot
    }),
    [captureRecord, saveAccountSnapshot, saveActiveViewRecord]
  )
}
