import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AuthSignInResult } from '../../../shared/auth'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, ThreadRow } from '../../../shared/mail'
import type { SearchResponse } from '../../../shared/searchQuery'
import { type DisplayThread, displayThreads, type MailView } from '../list/mailDisplay'
import { searchesDrafts, searchesLocalSnoozes, searchRetainsMovedThread } from '../searchView'
import { useLocalSearch } from './useLocalSearch'
import { type ServerSearchPhase, useServerSearch } from './useServerSearch'
import type { ViewRecordStore } from './useViewRecords'

interface Options {
  open: boolean
  setOpen: (open: boolean) => void
  openRef: React.RefObject<boolean>
  query: string
  setQuery: (query: string) => void
  view: MailView
  account: string | null
  mailRevision: number
  mailChangeSource: string | null
  online: boolean
  labels: readonly MailLabel[]
  readerOpen: boolean
  /** The full-window composer covers the list, so search must not steal focus. */
  composerCovering: boolean
  records: ViewRecordStore
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  selectedIndex: number
  /** Close the reader and invalidate any in-flight draft-open request. */
  finishReaderClose: () => void
  /** The move picker cannot outlive the list it was opened over. */
  closeMove: () => void
  reconnectGoogle: () => Promise<AuthSignInResult | null>
  listElRef: React.RefObject<HTMLElement | null>
  readerOpenRef: React.RefObject<boolean>
  selectedIndexRef: React.RefObject<number>
  selectedThreadIdRef: React.RefObject<string | null>
  selectedDraftIdRef: React.RefObject<string | null>
}

export interface SearchSession {
  /** 'query' types into the field; 'results' drives the row cursor (F4). */
  keyboardTarget: 'query' | 'results'
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Local hits first, then the Gmail-only remainder under a divider. */
  threads: DisplayThread[]
  drafts: readonly Draft[]
  /** Row ids in visible order — drafts in draft mode, threads otherwise. */
  rowIds: readonly string[]
  sectionDivider: { beforeIndex: number; label: string } | undefined
  /** The query the visible results answer; the typed one until a read lands. */
  resultQuery: string
  draftMode: boolean
  snoozeMode: boolean
  local: { pending: boolean; failed: boolean; response: SearchResponse | null; completedQuery: string | null }
  server: {
    phase: ServerSearchPhase
    message: string | null
    quotaWaitMs: number
    resultCount: number
  }
  /** Whether `Search all of Gmail` has anything left to run. */
  allEnabled: boolean
  /** Each also clears the list selection through the shell's wrapper. */
  openSearch: () => void
  clearSearch: () => void
  focusQuery: () => void
  focusResults: () => void
  submit: () => void
  /** Apply an optimistic row edit to both halves of the merged result. */
  updateRows: (updater: (rows: ThreadRow[]) => ThreadRow[]) => void
  /** Whether a moved thread still matches the query it was found by. */
  moveRetains: (thread: Parameters<typeof searchRetainsMovedThread>[1]) => boolean
}

/**
 * Find & focus (F4): the search field, the merged local + Gmail result list,
 * and the cursor over it. The list is one merged view — local hits, then the
 * Gmail-only remainder under a divider — and the cursor is preserved by result
 * identity, because both halves can refresh under it while it is being read.
 */
export function useSearchSession(options: Options): SearchSession {
  const latest = useRef(options)
  latest.current = options
  const {
    open,
    query,
    account,
    mailRevision,
    mailChangeSource,
    online,
    readerOpen,
    composerCovering,
    selectedIndex
  } = options
  const [keyboardTarget, setKeyboardTarget] = useState<'query' | 'results'>('query')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedRowIdRef = useRef<string | null>(null)
  const previousRowIdsRef = useRef<readonly string[]>([])

  const local = useLocalSearch(open, query, account, mailRevision)
  const server = useServerSearch(open, query, account, mailRevision, mailChangeSource, online)

  const localThreads = useMemo(() => displayThreads(local.response?.rows ?? []), [local.response])
  const serverThreads = useMemo(() => displayThreads(server.rows), [server.rows])
  const serverThreadIds = useMemo(() => new Set(serverThreads.map((thread) => thread.id)), [serverThreads])
  const visibleLocalThreads = useMemo(
    () => localThreads.filter((thread) => !serverThreadIds.has(thread.id)),
    [localThreads, serverThreadIds]
  )
  const threads = useMemo(
    () => [...visibleLocalThreads, ...serverThreads],
    [serverThreads, visibleLocalThreads]
  )
  const sectionDivider = useMemo(
    () =>
      serverThreads.length > 0
        ? { beforeIndex: visibleLocalThreads.length, label: 'More from Gmail' }
        : undefined,
    [serverThreads.length, visibleLocalThreads.length]
  )
  const drafts = useMemo(() => local.response?.drafts ?? [], [local.response])
  // A completed query keeps driving the visible results while the field is
  // being retyped; until one completes, the typed query stands in.
  const resultQuery = local.completedQuery ?? query
  const draftMode = open && searchesDrafts(resultQuery)
  const snoozeMode = open && searchesLocalSnoozes(resultQuery)
  const rowIds = useMemo(
    () => (draftMode ? drafts.map((draft) => draft.id) : threads.map((thread) => thread.id)),
    [draftMode, drafts, threads]
  )

  // Search results can refresh or reorder while their backing mailbox also
  // refreshes. Preserve the cursor by result identity instead of interpreting
  // its old numeric index against a new response.
  useLayoutEffect(() => {
    const { selectedThreadIdRef, setSelectedIndex } = latest.current
    if (!open) {
      previousRowIdsRef.current = []
      selectedRowIdRef.current = null
      return
    }
    if (previousRowIdsRef.current !== rowIds) {
      previousRowIdsRef.current = rowIds
      const previousId = selectedRowIdRef.current
      const restoredIndex = previousId ? rowIds.indexOf(previousId) : -1
      const nextIndex =
        restoredIndex >= 0
          ? restoredIndex
          : Math.max(0, Math.min(selectedIndex, Math.max(rowIds.length - 1, 0)))
      selectedRowIdRef.current = rowIds[nextIndex] ?? null
      if (nextIndex !== selectedIndex) setSelectedIndex(nextIndex)
      selectedThreadIdRef.current = draftMode ? null : selectedRowIdRef.current
      return
    }
    selectedRowIdRef.current = rowIds[selectedIndex] ?? null
    selectedThreadIdRef.current = draftMode ? null : selectedRowIdRef.current
  }, [draftMode, open, rowIds, selectedIndex])

  // The second render-time mirror: the derived search state the callbacks read
  // when they run, so none of them has to be rebuilt as results arrive.
  const derived = useRef({
    resultQuery,
    serverPhase: server.phase,
    serverRun: server.run,
    serverUpdateRows: server.updateRows,
    localUpdateRows: local.updateRows
  })
  derived.current = {
    resultQuery,
    serverPhase: server.phase,
    serverRun: server.run,
    serverUpdateRows: server.updateRows,
    localUpdateRows: local.updateRows
  }

  const focusQuery = useCallback(() => {
    const options = latest.current
    setKeyboardTarget('query')
    if (options.readerOpenRef.current) options.finishReaderClose()
    else inputRef.current?.focus({ preventScroll: true })
  }, [])

  const openSearch = useCallback(() => {
    const options = latest.current
    const { records, selectedThreadIdRef, selectedDraftIdRef, listElRef, selectedIndexRef } = options
    if (options.openRef.current) {
      focusQuery()
      return
    }
    setKeyboardTarget('query')
    const view = options.view
    const rowId =
      view === 'drafts' || view === 'outbox' ? selectedDraftIdRef.current : selectedThreadIdRef.current
    const currentRecord = {
      rowId,
      index: selectedIndexRef.current,
      scrollTop: listElRef.current?.scrollTop ?? 0
    }
    const record = options.readerOpenRef.current
      ? (records.viewRecords.current.get(view) ?? currentRecord)
      : currentRecord
    records.searchReturn.current = record
    if (view !== 'outbox') records.viewRecords.current.set(view, record)
    options.setSelectedIndex(0)
    selectedRowIdRef.current = null
    selectedThreadIdRef.current = null
    selectedDraftIdRef.current = null
    options.finishReaderClose()
    options.closeMove()
    options.setOpen(true)
  }, [focusQuery])

  const clearSearch = useCallback(() => {
    const options = latest.current
    const { records, selectedThreadIdRef, selectedDraftIdRef } = options
    if (!options.openRef.current) return
    const record = records.searchReturn.current ?? { rowId: null, index: 0, scrollTop: 0 }
    records.searchReturn.current = null
    options.setOpen(false)
    options.setQuery('')
    setKeyboardTarget('query')
    options.closeMove()
    const view = options.view
    records.pendingViewRestore.current = { view, record }
    const draftLikeView = view === 'drafts' || view === 'outbox'
    selectedDraftIdRef.current = draftLikeView ? record.rowId : null
    selectedThreadIdRef.current = draftLikeView ? null : record.rowId
    options.setSelectedIndex(Math.max(0, record.index))
  }, [])

  useLayoutEffect(() => {
    if (!open || readerOpen || composerCovering) return
    const target = keyboardTarget === 'query' ? inputRef.current : latest.current.listElRef.current
    target?.focus({ preventScroll: true })
  }, [composerCovering, keyboardTarget, open, readerOpen])

  const focusResults = useCallback(() => setKeyboardTarget('results'), [])

  const reconnectSearch = useCallback(() => {
    void latest.current.reconnectGoogle().then((result) => {
      if (result?.status.signedIn) derived.current.serverRun()
    })
  }, [])

  const submit = useCallback(() => {
    const options = latest.current
    focusResults()
    const query = options.query.trim()
    if (
      !query ||
      searchesDrafts(query) ||
      searchesLocalSnoozes(query) ||
      !options.online ||
      derived.current.serverPhase === 'waiting' ||
      derived.current.serverPhase === 'complete'
    ) {
      return
    }
    if (derived.current.serverPhase === 'auth-required') reconnectSearch()
    else derived.current.serverRun()
  }, [focusResults, reconnectSearch])

  // A failed or unavailable Gmail search puts the cursor back in the field:
  // there are no new rows to browse and the message sits beside the query.
  useEffect(() => {
    if (
      open &&
      !readerOpen &&
      (server.phase === 'auth-required' || server.phase === 'offline' || server.phase === 'error')
    ) {
      setKeyboardTarget('query')
    }
  }, [open, readerOpen, server.phase])

  const updateRows = useCallback((updater: (rows: ThreadRow[]) => ThreadRow[]) => {
    derived.current.localUpdateRows(updater)
    derived.current.serverUpdateRows(updater)
  }, [])

  const moveRetains = useCallback(
    (thread: Parameters<typeof searchRetainsMovedThread>[1]) =>
      searchRetainsMovedThread(derived.current.resultQuery, thread, latest.current.labels),
    []
  )

  const allEnabled =
    !draftMode &&
    !snoozeMode &&
    Boolean(query.trim()) &&
    online &&
    server.phase !== 'waiting' &&
    server.phase !== 'complete'

  return {
    keyboardTarget,
    inputRef,
    threads,
    drafts,
    rowIds,
    sectionDivider,
    resultQuery,
    draftMode,
    snoozeMode,
    local: {
      pending: local.pending,
      failed: local.failed,
      response: local.response,
      completedQuery: local.completedQuery
    },
    server: {
      phase: server.phase,
      message: server.message,
      quotaWaitMs: server.quotaWaitMs,
      resultCount: serverThreads.length
    },
    allEnabled,
    openSearch,
    clearSearch,
    focusQuery,
    focusResults,
    submit,
    updateRows,
    moveRetains
  }
}
