import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type AuthSignInResult, type AuthStatus, isSignInCanceled } from '../../../shared/auth'
import { type Draft, type DraftKind, emptyDraftInput } from '../../../shared/drafts'
import type { ConversationMailbox, MailLabel, ThreadListView, ThreadRow } from '../../../shared/mail'
import type { MoveDestination } from '../../../shared/move'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../../shared/splits'
import { actionReconnectMessage } from '../actionReconnect'
import { Composer, type ComposerHandle } from '../composer/Composer'
import { useConversation } from '../hooks/useConversation'
import { useInboxCommands } from '../hooks/useInboxCommands'
import { useKeyboardDispatch } from '../hooks/useKeyboardDispatch'
import { useLocalSearch } from '../hooks/useLocalSearch'
import { useMailData } from '../hooks/useMailData'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { useSelectionState } from '../hooks/useSelectionState'
import { useServerSearch } from '../hooks/useServerSearch'
import { useSplits } from '../hooks/useSplits'
import { useSyncActions } from '../hooks/useSyncActions'
import { useToast } from '../hooks/useToast'
import { useTriage } from '../hooks/useTriage'
import { type LabelCheckState, LabelPicker } from '../LabelPicker'
import { MovePicker, type MoveTarget } from '../MovePicker'
import {
  cachedThreadView,
  type DisplayThread,
  displaySnoozedThread,
  displaySnoozedThreads,
  displayThread,
  displayThreads,
  type MailView,
  type NavigableMailView,
  type PagedThreadView,
  userLabelId,
  userLabelView,
  VIEW_TITLES
} from '../mailDisplay'
import {
  conversationMailboxForSearch,
  retainedSearchQuery,
  searchAllowsMove,
  searchesDrafts,
  searchesLocalSnoozes,
  searchRetainsMovedThread,
  triageViewForSearch
} from '../searchView'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../sidebarState'
import { CommandPalette } from './CommandPalette'
import { ConversationView } from './ConversationView'
import { DraftList } from './DraftList'
import { MailFooter } from './MailFooter'
import { MailHeader } from './MailHeader'
import { MailSidebar } from './MailSidebar'
import { OutboxList } from './OutboxList'
import { SearchHeader, searchCoverageText } from './SearchHeader'
import { ServerSearchRow } from './ServerSearchRow'
import { SnoozePicker } from './SnoozePicker'
import { SplitRuleManager } from './SplitRuleManager'
import { SplitStrip } from './SplitStrip'
import { ThreadList } from './ThreadList'
import { Toast } from './Toast'

interface InboxProps {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}

/** Selection and scroll survive a round trip away from each view (SPEC F3). */
interface ViewRecord {
  rowId: string | null
  index: number
  scrollTop: number
}

interface MoveRequest {
  targets: readonly MoveTarget[]
  sourceLabelId: string | null
}

/**
 * The reader projection each view owns. All Mail deliberately maps to 'normal':
 * both hide spam and keep trashed-message markers, so the projections are
 * identical and sharing the value keeps the conversation cache warm across an
 * Inbox ⇄ All Mail switch.
 */
function conversationMailboxFor(view: MailView): ConversationMailbox {
  if (view === 'spam') return 'spam'
  if (view === 'trash') return 'trash'
  return 'normal'
}

function threadListKind(view: MailView): ThreadListView | 'label' {
  if (userLabelId(view)) return 'label'
  if (view !== 'drafts' && view !== 'outbox') return view as ThreadListView
  return 'inbox'
}

function titleForView(view: MailView, labelsById: ReadonlyMap<string, MailLabel>): string {
  const labelId = userLabelId(view)
  if (labelId) return labelsById.get(labelId)?.name ?? 'Label'
  return VIEW_TITLES[view as keyof typeof VIEW_TITLES]
}

function sidebarStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function Inbox({ status, onStatus }: InboxProps): React.JSX.Element {
  const [view, setView] = useState<MailView>('inbox')
  const [pendingChord, setPendingChord] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchKeyboardTarget, setSearchKeyboardTarget] = useState<'query' | 'results'>('query')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed(sidebarStorage()))
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [splitRulesOpen, setSplitRulesOpen] = useState(false)
  const [labelTargetIds, setLabelTargetIds] = useState<readonly string[] | null>(null)
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null)
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null)
  const [detachedDraftThread, setDetachedDraftThread] = useState<DisplayThread | null>(null)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectedDraftIdRef = useRef<string | null>(null)
  const activeViewRef = useRef<MailView>('inbox')
  const listElRef = useRef<HTMLElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchSelectedRowIdRef = useRef<string | null>(null)
  const previousSearchRowIdsRef = useRef<readonly string[]>([])
  const viewStateRef = useRef(new Map<MailView, ViewRecord>())
  const splitViewStateRef = useRef(new Map<string, ViewRecord>())
  const pendingSplitRestoreRef = useRef<{ id: string; record: ViewRecord } | null>(null)
  const pendingViewRestoreRef = useRef<{ view: MailView; record: ViewRecord } | null>(null)
  const searchReturnRef = useRef<ViewRecord | null>(null)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const setMailboxSelectedIndex = useCallback<React.Dispatch<React.SetStateAction<number>>>((next) => {
    if (!searchOpenRef.current) setSelectedIndex(next)
  }, [])
  // Render-time mirrors keep the view-switch callbacks referentially stable:
  // effects subscribe on top of switchView, and churning it re-runs them all.
  const selectedIndexRef = useRef(0)
  selectedIndexRef.current = selectedIndex
  const readerOpenRef = useRef(false)
  readerOpenRef.current = readerOpen
  const outboxReturnRef = useRef<{
    view: NavigableMailView
    selectedIndex: number
    readerOpen: boolean
  }>({
    view: 'inbox',
    selectedIndex: 0,
    readerOpen: false
  })
  const resetAccountRef = useRef<string | null | undefined>(undefined)
  const composerOpeningRef = useRef(false)
  const draftOpenRequestRef = useRef(0)
  const draftOpenTargetRef = useRef<{ request: number; draftId: string } | null>(null)
  const discardingDraftIdRef = useRef<string | null>(null)
  const activeComposerDraftIdRef = useRef<string | null>(null)
  const inlineComposerRef = useRef<ComposerHandle | null>(null)

  // The normalized account id — the key the utility uses for revert notices,
  // command usage, and every account-scoped row. `status.email` is display-only.
  const activeAccount = status.activeAccountId ?? status.email ?? null
  const splits = useSplits(activeAccount)
  const inboxSplitIdsKey = splits.state?.splits.map((split) => split.id).join('\u0000') ?? ''
  const inboxSplitRevision = splits.state?.revision
  const setActiveSplitForFocusRef = useRef(splits.setActiveSplitId)
  setActiveSplitForFocusRef.current = splits.setActiveSplitId
  const {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    loadedInboxSplitId,
    loadedInboxSplitStale,
    activateInboxSplitCache,
    preloadInboxSplits,
    realSnoozedThreads,
    setRealSnoozedThreads,
    mailboxRows,
    setMailboxRows,
    refreshCachedThreadView,
    threadPagination,
    loadMoreThreads,
    focusInboxThread,
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realMailboxCounts,
    realUnreadTotal,
    labels,
    pendingActionCount,
    pausedActionCount,
    mailRevision,
    mailChangeSource,
    invalidateConversations,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  } = useMailData(
    activeAccount,
    splits.activeSplitId,
    splits.activeSplitId ? (splits.state?.revision ?? null) : null,
    activeViewRef,
    selectedThreadIdRef,
    selectedDraftIdRef,
    setMailboxSelectedIndex
  )
  useEffect(() => {
    if (activeAccount && inboxSplitIdsKey && inboxSplitRevision !== undefined) {
      preloadInboxSplits(inboxSplitIdsKey.split('\u0000'))
    }
  }, [activeAccount, inboxSplitIdsKey, inboxSplitRevision, preloadInboxSplits])
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const online = networkOnline && sync.phase !== 'offline'
  const backingMailView = view === 'outbox' ? outboxReturnRef.current.view : view
  const backingCachedView = cachedThreadView(backingMailView)
  const activeInboxRowsReady =
    realThreads !== null && (!splits.state || loadedInboxSplitId === splits.activeSplitId)
  const activeInboxRowsResolved =
    activeInboxRowsReady && !(loadedInboxSplitStale && (realThreads?.length ?? 0) === 0)
  const activeInboxSelectionReady = activeInboxRowsReady && !loadedInboxSplitStale
  const mailboxThreads: DisplayThread[] = useMemo(
    () =>
      backingMailView === 'inbox'
        ? displayThreads(activeInboxRowsReady ? (realThreads ?? []) : [])
        : backingMailView === 'snoozed'
          ? displaySnoozedThreads(realSnoozedThreads ?? [])
          : backingCachedView
            ? displayThreads(mailboxRows[backingCachedView] ?? [])
            : [],
    [backingCachedView, backingMailView, activeInboxRowsReady, mailboxRows, realSnoozedThreads, realThreads]
  )
  const search = useLocalSearch(searchOpen, searchQuery, activeAccount, mailRevision)
  const serverSearch = useServerSearch(
    searchOpen,
    searchQuery,
    activeAccount,
    mailRevision,
    mailChangeSource,
    online
  )
  const localSearchThreads = useMemo(() => displayThreads(search.response?.rows ?? []), [search.response])
  const serverSearchThreads = useMemo(() => displayThreads(serverSearch.rows), [serverSearch.rows])
  const serverSearchThreadIds = useMemo(
    () => new Set(serverSearchThreads.map((thread) => thread.id)),
    [serverSearchThreads]
  )
  const visibleLocalSearchThreads = useMemo(
    () => localSearchThreads.filter((thread) => !serverSearchThreadIds.has(thread.id)),
    [localSearchThreads, serverSearchThreadIds]
  )
  const searchThreads = useMemo(
    () => [...visibleLocalSearchThreads, ...serverSearchThreads],
    [serverSearchThreads, visibleLocalSearchThreads]
  )
  const searchSectionDivider = useMemo(
    () =>
      serverSearchThreads.length > 0
        ? { beforeIndex: visibleLocalSearchThreads.length, label: 'More from Gmail' }
        : undefined,
    [serverSearchThreads.length, visibleLocalSearchThreads.length]
  )
  const searchDrafts = useMemo(() => search.response?.drafts ?? [], [search.response])
  const searchResultQuery = retainedSearchQuery(searchQuery, search.completedQuery)
  const searchDraftMode = searchOpen && searchesDrafts(searchResultQuery)
  const searchSnoozeMode = searchOpen && searchesLocalSnoozes(searchResultQuery)
  const moveAllowed = searchOpen
    ? searchAllowsMove(searchResultQuery)
    : view !== 'drafts' && view !== 'snoozed' && view !== 'outbox'
  const searchRowIds = useMemo(
    () =>
      searchDraftMode ? searchDrafts.map((draft) => draft.id) : searchThreads.map((thread) => thread.id),
    [searchDraftMode, searchDrafts, searchThreads]
  )
  const threads = searchOpen ? searchThreads : mailboxThreads
  const moveCacheRows = useMemo<ThreadRow[]>(
    () =>
      threads.map((thread) => ({
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
      })),
    [threads]
  )
  const activeViewTitle = titleForView(view, userLabelsById)
  const pagedView = searchOpen || view === 'drafts' || view === 'outbox' ? null : (view as PagedThreadView)
  const activePageState = pagedView ? threadPagination[pagedView] : undefined
  const systemPagedView = pagedView && !userLabelId(pagedView) ? (pagedView as ThreadListView) : null
  const exactSystemThreadCount =
    systemPagedView === 'inbox' && splits.activeSplitId
      ? (splits.state?.splits.find((split) => split.id === splits.activeSplitId)?.total ?? null)
      : systemPagedView
        ? (realMailboxCounts?.[systemPagedView] ?? null)
        : null
  const conversationThreadCount = detachedDraftThread
    ? 1
    : searchOpen
      ? threads.length
      : (exactSystemThreadCount ?? threads.length)
  const conversationThreadCountExact =
    searchOpen ||
    detachedDraftThread !== null ||
    exactSystemThreadCount !== null ||
    activePageState?.nextCursor === null
  const loadMoreVisibleThreads = useCallback(() => {
    if (pagedView) void loadMoreThreads(pagedView)
  }, [loadMoreThreads, pagedView])
  const { selectedIds, clearSelection, resetSelection, toggleFocusedSelection, extendSelectionTo } =
    useSelectionState(threads, selectedIndex, setSelectedIndex)

  const showDraft = useCallback(
    (draft: Draft) => {
      activeComposerDraftIdRef.current = draft.id
      if (draft.kind !== 'new' && draft.threadId) {
        const inboxIndex = (realThreads ?? []).findIndex((thread) => thread.id === draft.threadId)
        const snoozedIndex = (realSnoozedThreads ?? []).findIndex((thread) => thread.id === draft.threadId)
        const cachedThread =
          inboxIndex >= 0
            ? displayThread((realThreads ?? [])[inboxIndex])
            : snoozedIndex >= 0
              ? displaySnoozedThread((realSnoozedThreads ?? [])[snoozedIndex])
              : null
        const fallbackThread: DisplayThread = {
          id: draft.threadId,
          from: '',
          subject: draft.subject.replace(/^(?:(?:re|fwd?|forward)\s*:\s*)+/i, '') || '(no subject)',
          snippet: '',
          at: '',
          unread: false,
          starred: false,
          hasAttachment: false,
          snoozed: false,
          returned: false,
          hasDraft: true,
          labelIds: [],
          lastMsgAt: draft.updatedAt
        }

        if (activeViewRef.current === 'drafts') {
          // Keep Drafts as the navigation origin even when the parent thread is
          // also cached in Inbox or Snoozed. The reader can render that cached
          // thread as a detached item without changing the underlying list.
          selectedThreadIdRef.current = draft.threadId
          setReaderOpen(true)
          setSnoozeOpen(false)
          setLabelTargetIds(null)
          setDetachedDraftThread(cachedThread ?? fallbackThread)
          setComposerDraft(draft)
          return
        }
        const destination =
          inboxIndex >= 0
            ? { view: 'inbox' as const, index: inboxIndex }
            : snoozedIndex >= 0
              ? { view: 'snoozed' as const, index: snoozedIndex }
              : null
        if (destination) {
          activeViewRef.current = destination.view
          selectedThreadIdRef.current = draft.threadId
          selectedDraftIdRef.current = null
          clearSelection()
          setView(destination.view)
          setSelectedIndex(destination.index)
          setReaderOpen(true)
          setSnoozeOpen(false)
          setLabelTargetIds(null)
          setDetachedDraftThread(null)
        } else {
          setDetachedDraftThread(fallbackThread)
          selectedThreadIdRef.current = draft.threadId
          setReaderOpen(true)
        }
      }
      setComposerDraft(draft)
    },
    [clearSelection, realSnoozedThreads, realThreads]
  )

  // Account-scoped UI state has one reset owner. New transient surfaces, such
  // as the M2 composer, join this block rather than growing another effect.
  useEffect(() => {
    if (resetAccountRef.current === activeAccount) return
    resetAccountRef.current = activeAccount
    setSelectedIndex(0)
    setSearchOpen(false)
    setSearchQuery('')
    setReaderOpen(false)
    setSnoozeOpen(false)
    setSplitRulesOpen(false)
    setLabelTargetIds(null)
    setMoveRequest(null)
    setComposerDraft(null)
    setDetachedDraftThread(null)
    setComposerError(null)
    setExitingThreadIds(new Set())
    selectedThreadIdRef.current = null
    selectedDraftIdRef.current = null
    splitViewStateRef.current.clear()
    pendingSplitRestoreRef.current = null
    resetSelection()
  }, [activeAccount, resetSelection])

  useEffect(() => {
    if (!window.attn || !activeAccount) return
    let active = true
    void window.attn.draft
      .takeRecovered()
      .then((draft) => {
        if (active && draft) setComposerDraft(draft)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [activeAccount])

  useEffect(() => {
    activeComposerDraftIdRef.current = composerDraft?.id ?? null
  }, [composerDraft?.id])

  useEffect(() => {
    const visibleCount = searchDraftMode
      ? searchDrafts.length
      : searchOpen
        ? threads.length
        : view === 'drafts'
          ? realDrafts.length
          : view === 'outbox'
            ? realOutbox.length
            : threads.length
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(visibleCount - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    if ((searchOpen || view !== 'drafts') && threads.length === 0) setReaderOpen(false)
  }, [realDrafts.length, realOutbox.length, searchDraftMode, searchDrafts.length, searchOpen, threads, view])

  // Search results can refresh or reorder while their backing mailbox also
  // refreshes. Preserve the cursor by result identity instead of interpreting
  // its old numeric index against a new response.
  useLayoutEffect(() => {
    if (!searchOpen) {
      previousSearchRowIdsRef.current = []
      searchSelectedRowIdRef.current = null
      return
    }
    if (previousSearchRowIdsRef.current !== searchRowIds) {
      previousSearchRowIdsRef.current = searchRowIds
      const previousId = searchSelectedRowIdRef.current
      const restoredIndex = previousId ? searchRowIds.indexOf(previousId) : -1
      const nextIndex =
        restoredIndex >= 0
          ? restoredIndex
          : Math.max(0, Math.min(selectedIndex, Math.max(searchRowIds.length - 1, 0)))
      searchSelectedRowIdRef.current = searchRowIds[nextIndex] ?? null
      if (nextIndex !== selectedIndex) setSelectedIndex(nextIndex)
      selectedThreadIdRef.current = searchDraftMode ? null : searchSelectedRowIdRef.current
      return
    }
    searchSelectedRowIdRef.current = searchRowIds[selectedIndex] ?? null
    selectedThreadIdRef.current = searchDraftMode ? null : searchSelectedRowIdRef.current
  }, [searchDraftMode, searchOpen, searchRowIds, selectedIndex])

  const selected = detachedDraftThread ?? threads[selectedIndex]
  // Split and mailbox switches snapshot selection synchronously inside the same
  // key turn that can move the cursor. Mirror the visible thread id at render
  // time so a fast ArrowDown → split switch saves the new row, not the prior one.
  if (!searchOpen && view !== 'drafts' && view !== 'outbox') {
    selectedThreadIdRef.current = selected?.id ?? null
  }
  const conversationThreads = detachedDraftThread ? [detachedDraftThread] : threads
  const conversationSelectedIndex = detachedDraftThread ? 0 : selectedIndex
  const inlineComposerDraft =
    composerDraft && composerDraft.kind !== 'new' && readerOpen && selected?.id === composerDraft.threadId
      ? composerDraft
      : null
  const fullWindowComposerDraft = composerDraft && !inlineComposerDraft ? composerDraft : null

  useEffect(() => {
    writeSidebarCollapsed(sidebarStorage(), sidebarCollapsed)
  }, [sidebarCollapsed])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  const reopenDraftForThread = useCallback(
    (threadId: string) => {
      const draft = realDrafts.find(
        (candidate) => candidate.kind !== 'new' && candidate.threadId === threadId
      )
      if (!draft || !window.attn) return
      const request = ++draftOpenRequestRef.current
      draftOpenTargetRef.current = { request, draftId: draft.id }
      void window.attn.draft
        .reopen(draft.id)
        .then((reopened) => {
          if (!reopened) {
            if (draftOpenTargetRef.current?.request === request) draftOpenTargetRef.current = null
            return
          }
          const ownsResult =
            request === draftOpenRequestRef.current && selectedThreadIdRef.current === threadId
          if (ownsResult) {
            draftOpenTargetRef.current = null
            activeComposerDraftIdRef.current = reopened.id
            setComposerDraft(reopened)
            return
          }

          // `draft:reopen` mutates the row before returning it. If navigation
          // superseded this request, release that composing lease unless a
          // newer request or mounted composer already owns the same row.
          // Only a *different* request can be that owner: J/K moves the
          // selection without bumping the counter, so this request's own
          // entry is still parked here and must not be read as a competitor.
          const pending = draftOpenTargetRef.current
          if (pending?.request === request) draftOpenTargetRef.current = null
          const ownedByNewerRequest = pending !== null && pending.request !== request
          if (
            (ownedByNewerRequest && pending.draftId === reopened.id) ||
            activeComposerDraftIdRef.current === reopened.id
          ) {
            return
          }
          void window.attn?.draft.close(reopened.id).catch(() => {})
        })
        .catch(() => {
          if (draftOpenTargetRef.current?.request !== request) return
          draftOpenTargetRef.current = null
          if (activeComposerDraftIdRef.current !== draft.id) {
            void window.attn?.draft.close(draft.id).catch(() => {})
          }
        })
    },
    [realDrafts]
  )
  const { conversation, scrollRef: conversationScrollRef } = useConversation({
    selected,
    selectedIndex: conversationSelectedIndex,
    threads: conversationThreads,
    readerOpen,
    prefetch: selectedIds.size === 0,
    online,
    account: activeAccount,
    mailRevision,
    mailbox: searchOpen ? conversationMailboxForSearch(searchResultQuery) : conversationMailboxFor(view)
  })
  const targetedThreads =
    selectedIds.size > 0 ? threads.filter((thread) => selectedIds.has(thread.id)) : selected ? [selected] : []
  const starOn = targetedThreads.some((thread) => !thread.starred)
  const markUnreadOn = targetedThreads.some((thread) => !thread.unread)

  // Snapshot ids when the picker opens. A bulk apply clears the list selection,
  // but the open picker keeps operating on the same conversations.
  const labelTargets = useMemo(() => {
    if (labelTargetIds === null) return undefined
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]))
    const targets = labelTargetIds.flatMap((id) => {
      const thread = threadsById.get(id)
      return thread ? [thread] : []
    })
    return targets.length === labelTargetIds.length ? targets : undefined
  }, [labelTargetIds, threads])

  useEffect(() => {
    if (labelTargetIds !== null && !labelTargets) setLabelTargetIds(null)
  }, [labelTargetIds, labelTargets])

  useEffect(() => {
    if (composerDraft) setMoveRequest(null)
  }, [composerDraft])

  useEffect(() => {
    if (searchOpen) return
    selectedDraftIdRef.current =
      view === 'drafts'
        ? (realDrafts[selectedIndex]?.id ?? null)
        : view === 'outbox'
          ? (realOutbox[selectedIndex]?.id ?? null)
          : null
  }, [realDrafts, realOutbox, searchOpen, selectedIndex, view])

  const { retrySync, copySyncError } = useSyncActions(sync, showToast)

  useEffect(() => {
    if (!window.attn || !activeAccount) return
    return window.attn.mail.onActionsReverted(activeAccount, showToast)
  }, [activeAccount, showToast])

  const reconnectGoogle = useCallback(async (): Promise<AuthSignInResult | null> => {
    if (!window.attn) return null
    try {
      const result = await window.attn.auth.signIn()
      onStatus(result.status)
      return result
    } catch (reason) {
      // A canceled or superseded sign-in is not a failure worth a toast.
      if (!isSignInCanceled(reason)) {
        void showToast(reason instanceof Error ? reason.message : 'Could not reconnect Google')
      }
      return null
    }
  }, [onStatus, showToast])
  const reconnectActions = useCallback(() => {
    void reconnectGoogle().then((result) => {
      if (result) void showToast(actionReconnectMessage(activeAccount ?? '', result))
    })
  }, [activeAccount, reconnectGoogle, showToast])
  const reconnectSearch = useCallback(() => {
    void reconnectGoogle().then((result) => {
      if (result?.status.signedIn) serverSearch.run()
    })
  }, [reconnectGoogle, serverSearch.run])

  // Switching or adding an account swaps (remounts) the whole mail surface,
  // which would drop an open composer's not-yet-autosaved keystrokes. The
  // keyboard and palette are already inert while composing; these guards and
  // the menu's disabled rows make the pointer path match. `Esc` saves and
  // closes the draft first (F6), so nothing is ever lost to a switch.
  const accountActionsBlocked = composerDraft !== null
  // The guards below read this ref, not the captured boolean: an OAuth
  // completion (or any queued callback) can arrive minutes after the closure
  // was created, and only the ref knows whether a composer is open *now*.
  const composerOpenRef = useRef(false)
  composerOpenRef.current = accountActionsBlocked
  const switchAccount = useCallback(
    (accountId: string) => {
      if (!window.attn || accountId === status.activeAccountId) return
      if (composerOpenRef.current) {
        showToast('Save and close the draft before switching accounts')
        return
      }
      void window.attn.auth
        .setActiveAccount(accountId)
        .then(onStatus)
        .catch(() => void showToast('Could not switch accounts'))
    },
    [onStatus, showToast, status.activeAccountId]
  )
  // Adding an account is the same OAuth flow as reconnecting: an existing
  // address refreshes its tokens, a new one joins the roster (F18). Sign-in
  // no longer activates the addition — the browser flow can complete minutes
  // later, when a composer may be open — so activation goes through the
  // guarded switch here, and a blocked switch leaves the account added but
  // not active rather than dropping unsaved keystrokes.
  const addAccount = useCallback(() => {
    if (composerOpenRef.current) {
      showToast('Save and close the draft before adding an account')
      return
    }
    void reconnectGoogle().then((result) => {
      if (!result?.accountId || result.accountId === result.status.activeAccountId) return
      if (composerOpenRef.current) {
        void showToast(`Added ${result.accountId} — save the draft, then switch from the account menu`)
        return
      }
      switchAccount(result.accountId)
    })
  }, [reconnectGoogle, showToast, switchAccount])
  const accountCommands = useMemo(
    () => ({
      accounts: status.accounts,
      activeAccountId: status.activeAccountId,
      switchTo: switchAccount,
      add: addAccount
    }),
    [addAccount, status.accounts, status.activeAccountId, switchAccount]
  )

  const saveActiveViewRecord = useCallback(() => {
    const current = activeViewRef.current
    if (current === 'outbox') return
    // While the reader is open the list is display:none and reads scrollTop 0;
    // keep the last visible offset instead of clobbering it.
    const scrollTop = readerOpenRef.current
      ? (viewStateRef.current.get(current)?.scrollTop ?? 0)
      : (listElRef.current?.scrollTop ?? 0)
    viewStateRef.current.set(current, {
      rowId: current === 'drafts' ? selectedDraftIdRef.current : selectedThreadIdRef.current,
      index: selectedIndexRef.current,
      scrollTop
    })
  }, [])

  const switchViewNow = useCallback(
    (next: NavigableMailView) => {
      const previous = activeViewRef.current
      const wasSearching = searchOpenRef.current
      if (!wasSearching && previous !== next) saveActiveViewRecord()
      activeViewRef.current = next
      const record =
        wasSearching && previous === next
          ? (searchReturnRef.current ?? { rowId: null, index: 0, scrollTop: 0 })
          : (viewStateRef.current.get(next) ?? { rowId: null, index: 0, scrollTop: 0 })
      if (wasSearching) {
        searchReturnRef.current = null
        setSearchOpen(false)
        setSearchQuery('')
      }
      selectedDraftIdRef.current = next === 'drafts' ? record.rowId : null
      selectedThreadIdRef.current = next === 'drafts' ? null : record.rowId
      pendingViewRestoreRef.current = { view: next, record }
      // Reader projections differ per mailbox: a Trash reader must never reuse
      // an All Mail conversation, so drop the cache when the projection changes.
      if (conversationMailboxFor(previous) !== conversationMailboxFor(next)) invalidateConversations()
      const target = cachedThreadView(next)
      if (target) void refreshCachedThreadView(target).catch(() => {})
      clearSelection()
      setView(next)
      setSelectedIndex(Math.max(0, record.index))
      setReaderOpen(false)
      setSnoozeOpen(false)
      setLabelTargetIds(null)
      setMoveRequest(null)
      setDetachedDraftThread(null)
    },
    [clearSelection, invalidateConversations, refreshCachedThreadView, saveActiveViewRecord]
  )

  const switchView = useCallback(
    (next: NavigableMailView, afterSwitch?: () => void) => {
      if (inlineComposerDraft && inlineComposerRef.current) {
        inlineComposerRef.current.exitConversation(() => {
          switchViewNow(next)
          afterSwitch?.()
        })
        return
      }
      switchViewNow(next)
      afterSwitch?.()
    },
    [inlineComposerDraft, switchViewNow]
  )

  const switchSplit = useCallback(
    (id: string) => {
      const splitState = splits.state
      if (!splitState?.splits.some((split) => split.id === id)) return
      const currentId = splits.activeSplitId
      if (!searchOpenRef.current && activeViewRef.current === 'inbox' && currentId === id) return
      if (!searchOpenRef.current && activeViewRef.current === 'inbox' && currentId) {
        splitViewStateRef.current.set(currentId, {
          // Read the selected row from this render. The mirror ref updates in a
          // passive effect and can still point at the previous row if a user
          // presses J and immediately clicks another split.
          rowId: mailboxThreads[selectedIndexRef.current]?.id ?? selectedThreadIdRef.current,
          index: selectedIndexRef.current,
          scrollTop: readerOpenRef.current
            ? (splitViewStateRef.current.get(currentId)?.scrollTop ?? 0)
            : (listElRef.current?.scrollTop ?? 0)
        })
      }
      if (activeViewRef.current !== 'inbox' || searchOpenRef.current) switchViewNow('inbox')
      const record = splitViewStateRef.current.get(id) ?? { rowId: null, index: 0, scrollTop: 0 }
      pendingSplitRestoreRef.current = { id, record }
      selectedThreadIdRef.current = record.rowId
      selectedDraftIdRef.current = null
      clearSelection()
      setReaderOpen(false)
      setSnoozeOpen(false)
      setLabelTargetIds(null)
      setSelectedIndex(Math.max(0, record.index))
      activateInboxSplitCache(id)
      splits.setActiveSplitId(id)
    },
    [activateInboxSplitCache, clearSelection, mailboxThreads, splits, switchViewNow]
  )

  const moveSplit = useCallback(
    (direction: -1 | 1) => {
      const splitState = splits.state
      const currentId = splits.activeSplitId
      if (!splitState || !currentId) return
      const current = splitState.splits.findIndex((split) => split.id === currentId)
      if (current < 0) return
      const next = (current + direction + splitState.splits.length) % splitState.splits.length
      switchSplit(splitState.splits[next].id)
    },
    [splits.activeSplitId, splits.state, switchSplit]
  )

  // Stale split rows can paint immediately, but selection restoration depends
  // on their final order and waits for the SQLite revalidation.
  const viewRowsLoaded =
    view === 'outbox'
      ? true
      : backingMailView === 'inbox'
        ? activeInboxSelectionReady
        : backingMailView === 'snoozed'
          ? realSnoozedThreads !== null
          : backingCachedView
            ? mailboxRows[backingCachedView] !== undefined
            : true

  // Restore the returning view's selection and scroll once its rows are in
  // state. Selection follows the thread id first — refreshed rows may have
  // moved it — and falls back to the clamped index when the thread left the
  // view. ThreadList's follow-scroll then keeps the row visible if the two
  // restored halves disagree.
  useLayoutEffect(() => {
    const pending = pendingViewRestoreRef.current
    if (!pending || pending.view !== view || !viewRowsLoaded) return
    pendingViewRestoreRef.current = null
    const record = pending.record
    const rowIds =
      view === 'drafts'
        ? realDrafts.map((draft) => draft.id)
        : view === 'outbox'
          ? realOutbox.map((item) => item.id)
          : threads.map((thread) => thread.id)
    const restoredIndex = record.rowId ? rowIds.indexOf(record.rowId) : -1
    const nextIndex =
      restoredIndex >= 0 ? restoredIndex : Math.max(0, Math.min(record.index, rowIds.length - 1))
    const draftLikeView = view === 'drafts' || view === 'outbox'
    selectedDraftIdRef.current = draftLikeView ? (rowIds[nextIndex] ?? null) : null
    selectedThreadIdRef.current = draftLikeView ? null : (rowIds[nextIndex] ?? null)
    setSelectedIndex(nextIndex)
    const list = listElRef.current
    if (list) list.scrollTop = record.scrollTop
  }, [realDrafts, realOutbox, threads, view, viewRowsLoaded])

  useLayoutEffect(() => {
    const pending = pendingSplitRestoreRef.current
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
    pendingSplitRestoreRef.current = null
    const restoredIndex = pending.record.rowId
      ? realThreads.findIndex((thread) => thread.id === pending.record.rowId)
      : -1
    const nextIndex =
      restoredIndex >= 0
        ? restoredIndex
        : Math.max(0, Math.min(pending.record.index, Math.max(0, realThreads.length - 1)))
    selectedThreadIdRef.current = realThreads[nextIndex]?.id ?? null
    setSelectedIndex(nextIndex)
    if (listElRef.current) listElRef.current.scrollTop = pending.record.scrollTop
  }, [loadedInboxSplitId, loadedInboxSplitStale, realThreads, splits.activeSplitId, view])

  const openOutboxNow = useCallback(() => {
    if (view === 'outbox') {
      if (searchOpenRef.current) {
        const record = searchReturnRef.current ?? { rowId: null, index: 0, scrollTop: 0 }
        searchReturnRef.current = null
        setSearchOpen(false)
        setSearchQuery('')
        pendingViewRestoreRef.current = { view: 'outbox', record }
        selectedDraftIdRef.current = record.rowId
        selectedThreadIdRef.current = null
        setSelectedIndex(Math.max(0, record.index))
      }
      return
    }
    if (searchOpenRef.current) {
      searchReturnRef.current = null
      setSearchOpen(false)
      setSearchQuery('')
    }
    outboxReturnRef.current = { view, selectedIndex, readerOpen }
    activeViewRef.current = 'outbox'
    selectedDraftIdRef.current = null
    setView('outbox')
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetIds(null)
    setMoveRequest(null)
  }, [readerOpen, selectedIndex, view])

  const openOutbox = useCallback(() => {
    if (view === 'outbox' && !searchOpenRef.current) return
    if (inlineComposerDraft && inlineComposerRef.current) {
      inlineComposerRef.current.exitConversation(openOutboxNow)
      return
    }
    openOutboxNow()
  }, [inlineComposerDraft, openOutboxNow, view])

  const closeOutbox = useCallback(() => {
    const previous = outboxReturnRef.current
    activeViewRef.current = previous.view
    selectedDraftIdRef.current = null
    setView(previous.view)
    setSelectedIndex(previous.selectedIndex)
    setReaderOpen(previous.readerOpen)
  }, [])

  useEffect(() => {
    const bridge = window.attn
    if (!bridge || !activeAccount) return
    return bridge.mail.onFocusThread((threadId) => {
      // Close the old reader before changing lists so auto-read cannot observe
      // an old cursor against Inbox and mutate the wrong thread.
      switchView('inbox', () => {
        clearSelection()
        void (async () => {
          const openTarget = (nextIndex: number): void => {
            // The notification target owns the selection: cancel any saved
            // record the switch queued so it cannot override this focus.
            pendingViewRestoreRef.current = null
            pendingSplitRestoreRef.current = null
            selectedThreadIdRef.current = threadId
            setDetachedDraftThread(null)
            setSelectedIndex(nextIndex)
            setReaderOpen(true)
          }
          // A rule edit can land between location lookup and page fetch. Retry
          // once with a fresh atomic split id + revision instead of dropping the
          // native notification click.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const location = await bridge.splits.getThreadLocation(threadId)
            if (!location) {
              // The deterministic legacy test profile intentionally has no
              // split setup. Preserve its whole-Inbox notification path.
              const nextIndex = await focusInboxThread(threadId, null).catch(() => null)
              if (nextIndex !== null) openTarget(nextIndex)
              return
            }
            setActiveSplitForFocusRef.current(location.splitId)
            const nextIndex = await focusInboxThread(threadId, location.splitId, location.revision).catch(
              () => null
            )
            if (nextIndex === null) continue
            openTarget(nextIndex)
            return
          }
        })().catch(() => {})
      })
    })
  }, [activeAccount, clearSelection, focusInboxThread, switchView])

  const updateSearchRows = useCallback(
    (updater: Parameters<typeof search.updateRows>[0]) => {
      search.updateRows(updater)
      serverSearch.updateRows(updater)
    },
    [search.updateRows, serverSearch.updateRows]
  )
  const searchMoveRetains = useCallback(
    (thread: Parameters<typeof searchRetainsMovedThread>[1]) =>
      searchRetainsMovedThread(searchResultQuery, thread, labels),
    [labels, searchResultQuery]
  )

  const triage = useTriage({
    selectedIds,
    selectedIndex,
    threads,
    moveCacheRows,
    readerOpen,
    view: searchOpen ? triageViewForSearch(searchResultQuery) : view,
    activeSplitId: searchOpen ? null : splits.activeSplitId,
    searchOpen,
    searchMoveRetains: searchOpen ? searchMoveRetains : undefined,
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
    updateSearchRows: searchOpen ? updateSearchRows : undefined,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex
  })

  const toggleLabel = useCallback(
    (label: MailLabel, state: LabelCheckState) => {
      if (!labelTargets) return
      triage({
        kind: 'label',
        threadIds: labelTargets.map((target) => target.id),
        add: state === 'all' ? [] : [label.id],
        remove: state === 'all' ? [label.id] : []
      })
    },
    [labelTargets, triage]
  )

  const openOutboxItem = useCallback(
    (index: number) => {
      const item = realOutbox[index]
      if (!item || !window.attn) return
      if (item.state === 'sending') {
        showToast('Sending in progress')
        return
      }
      const request =
        item.state === 'queued' ? window.attn.outbox.undoSend(item.id) : window.attn.outbox.reopen(item.id)
      void request
        .then((result) => {
          if (!result.draft) {
            if (result.error) showToast(result.error)
            return
          }
          setComposerError(result.error)
          setComposerDraft(result.draft)
        })
        .catch(() => showToast('Message could not be reopened'))
    },
    [realOutbox, showToast]
  )

  const reopenUndoDraft = useCallback((id: string) => {
    if (!window.attn) return
    void window.attn.draft
      .get(id)
      .then((draft) => {
        if (!draft) return
        setComposerError(null)
        setComposerDraft(draft)
      })
      .catch(() => {})
  }, [])

  const openSelected = useCallback(() => {
    if (searchDraftMode) {
      const draft = searchDrafts[selectedIndex]
      if (!draft || !window.attn) return
      void window.attn.draft
        .reopen(draft.id)
        .then((reopened) => {
          if (reopened) showDraft(reopened)
        })
        .catch(() => {})
      return
    }
    if (!searchOpen && view === 'outbox') {
      openOutboxItem(selectedIndex)
      return
    }
    if (!searchOpen && view === 'drafts') {
      const draft = realDrafts[selectedIndex]
      if (!draft || !window.attn) return
      void window.attn.draft
        .reopen(draft.id)
        .then((reopened) => {
          if (reopened) showDraft(reopened)
        })
        .catch(() => {})
      return
    }
    const thread = threads[selectedIndex]
    if (!thread) return
    if (!searchOpen) {
      viewStateRef.current.set(view, {
        rowId: thread.id,
        index: selectedIndex,
        scrollTop: listElRef.current?.scrollTop ?? 0
      })
    }
    selectedThreadIdRef.current = thread.id
    setReaderOpen(true)
    reopenDraftForThread(thread.id)
  }, [
    openOutboxItem,
    realDrafts,
    reopenDraftForThread,
    searchDraftMode,
    searchDrafts,
    searchOpen,
    selectedIndex,
    showDraft,
    threads,
    view
  ])
  const finishReaderClose = useCallback(() => {
    draftOpenRequestRef.current += 1
    draftOpenTargetRef.current = null
    setReaderOpen(false)
    setDetachedDraftThread(null)
  }, [])
  const closeReader = useCallback(() => {
    if (inlineComposerDraft && inlineComposerRef.current) {
      inlineComposerRef.current.exitConversation()
      return
    }
    finishReaderClose()
  }, [finishReaderClose, inlineComposerDraft])
  const focusSearchQuery = useCallback(() => {
    setSearchKeyboardTarget('query')
    clearSelection()
    if (readerOpenRef.current) finishReaderClose()
    else searchInputRef.current?.focus({ preventScroll: true })
  }, [clearSelection, finishReaderClose])
  const openSearch = useCallback(() => {
    if (searchOpenRef.current) {
      focusSearchQuery()
      return
    }
    setSearchKeyboardTarget('query')
    const rowId =
      view === 'drafts' || view === 'outbox' ? selectedDraftIdRef.current : selectedThreadIdRef.current
    const currentRecord = {
      rowId,
      index: selectedIndexRef.current,
      scrollTop: listElRef.current?.scrollTop ?? 0
    }
    const record = readerOpenRef.current ? (viewStateRef.current.get(view) ?? currentRecord) : currentRecord
    searchReturnRef.current = record
    if (view !== 'outbox') viewStateRef.current.set(view, record)
    clearSelection()
    setSelectedIndex(0)
    searchSelectedRowIdRef.current = null
    selectedThreadIdRef.current = null
    selectedDraftIdRef.current = null
    finishReaderClose()
    setMoveRequest(null)
    setSearchOpen(true)
  }, [clearSelection, finishReaderClose, focusSearchQuery, view])
  const clearSearch = useCallback(() => {
    if (!searchOpenRef.current) return
    const record = searchReturnRef.current ?? { rowId: null, index: 0, scrollTop: 0 }
    searchReturnRef.current = null
    setSearchOpen(false)
    setSearchQuery('')
    setSearchKeyboardTarget('query')
    setMoveRequest(null)
    clearSelection()
    pendingViewRestoreRef.current = { view, record }
    const draftLikeView = view === 'drafts' || view === 'outbox'
    selectedDraftIdRef.current = draftLikeView ? record.rowId : null
    selectedThreadIdRef.current = draftLikeView ? null : record.rowId
    setSelectedIndex(Math.max(0, record.index))
  }, [clearSelection, view])
  useLayoutEffect(() => {
    if (!searchOpen || readerOpen || fullWindowComposerDraft) return
    const target = searchKeyboardTarget === 'query' ? searchInputRef.current : listElRef.current
    target?.focus({ preventScroll: true })
  }, [fullWindowComposerDraft, readerOpen, searchKeyboardTarget, searchOpen])
  const focusSearchResults = useCallback(() => setSearchKeyboardTarget('results'), [])
  const submitSearch = useCallback(() => {
    focusSearchResults()
    const query = searchQuery.trim()
    if (
      !query ||
      searchesDrafts(query) ||
      searchesLocalSnoozes(query) ||
      !online ||
      serverSearch.phase === 'waiting' ||
      serverSearch.phase === 'complete'
    ) {
      return
    }
    if (serverSearch.phase === 'auth-required') reconnectSearch()
    else serverSearch.run()
  }, [focusSearchResults, online, reconnectSearch, searchQuery, serverSearch.phase, serverSearch.run])
  useEffect(() => {
    if (
      searchOpen &&
      !readerOpen &&
      (serverSearch.phase === 'auth-required' ||
        serverSearch.phase === 'offline' ||
        serverSearch.phase === 'error')
    ) {
      setSearchKeyboardTarget('query')
    }
  }, [readerOpen, searchOpen, serverSearch.phase])
  const closeSnooze = useCallback(() => setSnoozeOpen(false), [])
  const closeLabel = useCallback(() => setLabelTargetIds(null), [])
  const closeMove = useCallback(() => setMoveRequest(null), [])
  const openSnooze = useCallback(() => {
    if (selected) setSnoozeOpen(true)
  }, [selected])
  const openLabel = useCallback(() => {
    if (!selected) return
    setLabelTargetIds(selectedIds.size > 0 ? [...selectedIds] : [selected.id])
  }, [selected, selectedIds])
  const openMove = useCallback(() => {
    if (!selected || !moveAllowed) return
    setMoveRequest({
      targets: targetedThreads.map((thread) => ({
        id: thread.id,
        labelIds: [...thread.labelIds],
        snoozed: thread.snoozed,
        returned: thread.returned
      })),
      sourceLabelId: searchOpen ? null : userLabelId(view)
    })
  }, [moveAllowed, searchOpen, selected, targetedThreads, view])
  const moveSelected = useCallback(
    (destination: MoveDestination) => {
      if (!moveRequest) return
      setMoveRequest(null)
      triage({
        kind: 'move',
        threadIds: moveRequest.targets.map((target) => target.id),
        destination,
        sourceLabelId: moveRequest.sourceLabelId
      })
    },
    [moveRequest, triage]
  )
  const markNotDone = useCallback(() => {
    if (!selected) return
    triage({
      kind: 'move',
      threadIds: selectedIds.size > 0 ? [...selectedIds] : [selected.id],
      destination: { kind: 'inbox' },
      sourceLabelId: null,
      verb: 'markNotDone'
    })
  }, [selected, selectedIds, triage])
  const openThread = useCallback(
    (index: number) => {
      const thread = threads[index]
      if (!thread) return
      // Opening unread mail can immediately broadcast a mark-read refresh. Pin
      // the identity before that refresh starts; the effect that mirrors index
      // changes is deliberately too late for this transition.
      selectedThreadIdRef.current = thread.id
      if (!searchOpen) {
        viewStateRef.current.set(view, {
          rowId: thread.id,
          index,
          scrollTop: listElRef.current?.scrollTop ?? 0
        })
      }
      setDetachedDraftThread(null)
      setSelectedIndex(index)
      setReaderOpen(true)
      reopenDraftForThread(thread.id)
    },
    [reopenDraftForThread, searchOpen, threads, view]
  )
  const openComposer = useCallback(() => {
    if (!window.attn || composerOpeningRef.current) return
    composerOpeningRef.current = true
    void window.attn.draft
      .save(emptyDraftInput())
      .then(({ draft }) => {
        if (draft) {
          setComposerError(null)
          setComposerDraft(draft)
        }
      })
      .catch(() => {})
      .finally(() => {
        composerOpeningRef.current = false
      })
  }, [])

  const openReply = useCallback(
    (kind: Exclude<DraftKind, 'new'>) => {
      if (!window.attn || !selected || (!searchOpen && view === 'drafts') || composerOpeningRef.current)
        return
      if (!readerOpen) {
        selectedThreadIdRef.current = selected.id
        setDetachedDraftThread(null)
        setReaderOpen(true)
        setSnoozeOpen(false)
        setLabelTargetIds(null)
      }
      composerOpeningRef.current = true
      const replyMailbox = searchOpen
        ? conversationMailboxForSearch(searchResultQuery)
        : conversationMailboxFor(view)
      void window.attn.draft
        .createReply(selected.id, kind, replyMailbox)
        .then((draft) => {
          if (draft) {
            setComposerError(null)
            showDraft(draft)
          }
        })
        .catch(() => {})
        .finally(() => {
          composerOpeningRef.current = false
        })
    },
    [readerOpen, searchOpen, searchResultQuery, selected, showDraft, view]
  )

  const closeComposer = useCallback(() => {
    activeComposerDraftIdRef.current = null
    // Closing is the local handoff from an inline composer back to its
    // conversation. Invalidate directly instead of relying on the outbox event
    // racing the IPC response, so a queued reply/forward is fetched in the same
    // render turn that removes the composer.
    invalidateConversations()
    setComposerDraft(null)
    void refreshMailRows().catch(() => {
      void refreshDrafts().catch(() => {})
    })
  }, [invalidateConversations, refreshDrafts, refreshMailRows])
  const closeComposerAndReader = useCallback(() => {
    closeComposer()
    finishReaderClose()
  }, [closeComposer, finishReaderClose])

  const snoozeSelected = useCallback(
    (dueAt: number) => {
      if (!window.attn || !selected) return
      const isBulk = selectedIds.size > 0
      const threadIds = isBulk ? [...selectedIds] : [selected.id]
      closeSnooze()
      if (isBulk) clearSelection()
      void window.attn.mail
        .snooze(threadIds, dueAt)
        .then((result) => showToast(result.label))
        .catch(() => {})
    },
    [clearSelection, closeSnooze, selected, selectedIds, showToast]
  )

  const unsnoozeSelected = useCallback(() => {
    if (!selected) return
    closeSnooze()
    triage({ kind: 'unsnooze', threadIds: [selected.id] })
  }, [closeSnooze, selected, triage])

  const visibleRowCount = searchDraftMode
    ? searchDrafts.length
    : searchOpen
      ? threads.length
      : view === 'drafts'
        ? realDrafts.length
        : view === 'outbox'
          ? realOutbox.length
          : threads.length

  // While reading, J/K opens the next/previous conversation at its newest
  // message or restored draft (SPEC §5) — the same entry point Enter and a row
  // click use, so a Draft chip behaves identically however the row is reached.
  const readNextThread = useCallback(
    (index: number) => {
      if (!readerOpen || (!searchOpen && (view === 'drafts' || view === 'outbox'))) return
      const thread = threads[index]
      if (!thread) return
      selectedThreadIdRef.current = thread.id
      reopenDraftForThread(thread.id)
    },
    [readerOpen, reopenDraftForThread, searchOpen, threads, view]
  )

  const navigateNext = useCallback(() => {
    if (detachedDraftThread) {
      finishReaderClose()
      return
    }
    const next = Math.min(selectedIndex + 1, Math.max(visibleRowCount - 1, 0))
    setSelectedIndex(next)
    if (next !== selectedIndex) readNextThread(next)
  }, [detachedDraftThread, finishReaderClose, readNextThread, selectedIndex, visibleRowCount])

  const navigatePrevious = useCallback(() => {
    if (detachedDraftThread) {
      finishReaderClose()
      return
    }
    if (readerOpen && selectedIndex === 0) {
      closeReader()
      return
    }
    const previous = Math.max(selectedIndex - 1, 0)
    setSelectedIndex(previous)
    if (previous !== selectedIndex) readNextThread(previous)
  }, [closeReader, detachedDraftThread, finishReaderClose, readNextThread, readerOpen, selectedIndex])

  const discardSelectedDraft = useCallback(() => {
    if (searchOpen || view !== 'drafts' || !window.attn || discardingDraftIdRef.current) return
    const draft = realDrafts[selectedIndex]
    if (!draft) return
    discardingDraftIdRef.current = draft.id
    void window.attn.draft
      .discard(draft.id, 'drafted')
      .then(() => {
        showToast('Draft discarded')
        void refreshMailRows().catch(() => {
          void refreshDrafts().catch(() => {})
        })
      })
      .catch(() => showToast('Draft could not be discarded'))
      .finally(() => {
        discardingDraftIdRef.current = null
      })
  }, [realDrafts, refreshDrafts, refreshMailRows, searchOpen, selectedIndex, showToast, view])

  const splitCommands = useMemo(() => {
    if (!splits.state || splits.state.splits.length === 0) return null
    return {
      previous: () => moveSplit(-1),
      next: () => moveSplit(1),
      manage: () => setSplitRulesOpen(true),
      goTo: splits.state.splits.map((split) => ({
        id: split.id,
        name: split.name,
        run: () => switchSplit(split.id)
      }))
    }
  }, [moveSplit, splits.state, switchSplit])

  useInboxCommands({
    selected,
    selectedCount: selectedIds.size,
    selectedIndex,
    readerOpen,
    view,
    searchOpen,
    searchBrowsing: searchOpen && searchKeyboardTarget === 'results' && !readerOpen,
    sidebarCollapsed,
    starOn,
    markUnreadOn,
    moveAllowed,
    preserveSelectionOnRefreshRef,
    navigateNext,
    navigatePrevious,
    clearSelection,
    toggleSelection: toggleFocusedSelection,
    extendSelection: extendSelectionTo,
    openSelected,
    closeReader,
    switchView,
    openOutbox,
    closeOutbox,
    discardSelectedDraft: !searchOpen && view === 'drafts' ? discardSelectedDraft : null,
    toggleSidebar,
    openSearch,
    focusSearchQuery,
    searchAllEnabled:
      !searchDraftMode &&
      !searchSnoozeMode &&
      Boolean(searchQuery.trim()) &&
      online &&
      serverSearch.phase !== 'waiting' &&
      serverSearch.phase !== 'complete',
    submitSearch,
    clearSearch,
    triage,
    openSnooze,
    snoozeAt: snoozeSelected,
    openLabel,
    openMove,
    markNotDone,
    openComposer,
    openReply,
    showToast,
    reopenUndoDraft,
    splitCommands,
    accountCommands
  })

  useKeyboardDispatch({
    blocked: labelTargets !== undefined || moveRequest !== null || composerDraft !== null || splitRulesOpen,
    readerOpen,
    outboxOpen: !searchOpen && view === 'outbox',
    snoozeOpen,
    onCloseSnooze: closeSnooze,
    viewKey: `${view}:${readerOpen ? 'reader' : 'list'}:${
      searchOpen ? searchKeyboardTarget : 'mail'
    }:${splits.activeSplitId ?? ''}`,
    onPendingChordChange: setPendingChord,
    conversationScrollRef
  })

  useSelectedRowScroll(selectedRowRef, selectedIndex, readerOpen)

  useEffect(() => {
    if (!outboxFailure) return
    showToast(outboxFailure.error)
    clearOutboxFailure()
  }, [clearOutboxFailure, outboxFailure, showToast])

  return (
    <div className="flex h-full flex-col">
      <MailHeader
        unreadCount={realUnreadTotal}
        pendingActionCount={pendingActionCount}
        pausedActionCount={pausedActionCount}
        outboxCount={realOutbox.length}
        selectionCount={searchOpen || (view !== 'drafts' && view !== 'outbox') ? selectedIds.size : 0}
        composerOpen={fullWindowComposerDraft !== null}
        sidebarCollapsed={sidebarCollapsed}
        status={status}
        onStatus={onStatus}
        onReconnectActions={reconnectActions}
        onOpenOutbox={openOutbox}
        onToggleSidebar={toggleSidebar}
        onManageSplits={() => setSplitRulesOpen(true)}
        onSwitchAccount={switchAccount}
        onAddAccount={addAccount}
        accountActionsBlocked={accountActionsBlocked}
      />

      <div
        className={`min-h-0 flex-1 ${fullWindowComposerDraft ? 'hidden' : 'flex'}`}
        aria-hidden={!!fullWindowComposerDraft}
      >
        {!sidebarCollapsed && (
          <MailSidebar
            view={view}
            labels={labels}
            mailboxCounts={realMailboxCounts}
            draftCount={realDrafts.length}
            outboxCount={realOutbox.length}
            onSwitchView={switchView}
            onOpenOutbox={openOutbox}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {!readerOpen &&
            !fullWindowComposerDraft &&
            (searchOpen ? (
              <SearchHeader
                inputRef={searchInputRef}
                query={searchQuery}
                pending={search.pending}
                onQuery={setSearchQuery}
                onClear={clearSearch}
                onFocusQuery={focusSearchQuery}
                onSubmit={submitSearch}
              />
            ) : (
              <div
                data-testid="mail-view-header"
                className="flex h-[44px] flex-none items-center border-b border-edge pr-7 pl-[53px]"
              >
                <h1 data-testid="mailbox-title" className="text-base font-semibold text-ink">
                  <span data-testid="view-title">{activeViewTitle}</span>
                </h1>
                <button
                  type="button"
                  data-testid="search-open"
                  aria-label="Search mail"
                  title="Search mail (/)"
                  onClick={openSearch}
                  className="app-no-drag ml-auto flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-ink"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current">
                    <circle cx="10.5" cy="10.5" r="6.5" strokeWidth="1.8" />
                    <path d="m15.5 15.5 4 4" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <span>/</span>
                </button>
              </div>
            ))}
          {!readerOpen && !fullWindowComposerDraft && !searchOpen && view === 'inbox' && splits.state && (
            <SplitStrip
              splits={splits.state.splits}
              activeSplitId={splits.activeSplitId}
              onSelect={switchSplit}
              onManage={() => setSplitRulesOpen(true)}
            />
          )}
          <div className={`flex min-h-0 flex-1 ${searchOpen && !readerOpen ? 'flex-col' : ''}`}>
            {searchDraftMode ? (
              <DraftList
                drafts={searchDrafts}
                readerOpen={false}
                selectedIndex={selectedIndex}
                selectionVisible={searchKeyboardTarget === 'results'}
                selectedRowRef={selectedRowRef}
                listRef={listElRef}
                onOpen={(index) => {
                  setSearchKeyboardTarget('results')
                  setSelectedIndex(index)
                  const draft = searchDrafts[index]
                  if (!draft || !window.attn) return
                  void window.attn.draft
                    .reopen(draft.id)
                    .then((reopened) => {
                      if (reopened) showDraft(reopened)
                    })
                    .catch(() => {})
                }}
              />
            ) : !searchOpen && view === 'drafts' ? (
              <DraftList
                drafts={realDrafts}
                readerOpen={readerOpen}
                selectedIndex={selectedIndex}
                selectedRowRef={selectedRowRef}
                listRef={listElRef}
                onOpen={(index) => {
                  setSelectedIndex(index)
                  const draft = realDrafts[index]
                  if (!draft || !window.attn) return
                  selectedDraftIdRef.current = draft.id
                  void window.attn.draft
                    .reopen(draft.id)
                    .then((reopened) => {
                      if (reopened) showDraft(reopened)
                    })
                    .catch(() => {})
                }}
              />
            ) : !searchOpen && view === 'outbox' ? (
              <OutboxList
                items={realOutbox}
                selectedIndex={selectedIndex}
                selectedRowRef={selectedRowRef}
                listRef={listElRef}
                onOpen={(index) => {
                  setSelectedIndex(index)
                  selectedDraftIdRef.current = realOutbox[index]?.id ?? null
                  openOutboxItem(index)
                }}
              />
            ) : (
              <ThreadList
                threads={threads}
                view={searchOpen ? 'search' : threadListKind(view)}
                hasMore={!searchOpen && activePageState?.nextCursor !== null && activePageState !== undefined}
                loadingMore={!searchOpen && (activePageState?.loadingMore ?? false)}
                loadingInitial={!searchOpen && view === 'inbox' && !activeInboxRowsResolved}
                syncing={!searchOpen && sync.phase === 'syncing'}
                readerOpen={readerOpen}
                selectedIndex={selectedIndex}
                selectionVisible={!searchOpen || searchKeyboardTarget === 'results'}
                selectedIds={selectedIds}
                exitingThreadIds={exitingThreadIds}
                labelsById={userLabelsById}
                selectedRowRef={selectedRowRef}
                listRef={listElRef}
                onExtendSelection={extendSelectionTo}
                onLoadMore={loadMoreVisibleThreads}
                onOpenLabel={(labelId) => switchView(userLabelView(labelId))}
                onOpen={(index) => {
                  if (searchOpen) setSearchKeyboardTarget('results')
                  openThread(index)
                }}
                sectionDivider={searchOpen ? searchSectionDivider : undefined}
              />
            )}

            {searchOpen && !readerOpen && !searchDraftMode && !searchSnoozeMode && searchQuery.trim() && (
              <ServerSearchRow
                phase={serverSearch.phase}
                resultCount={serverSearchThreads.length}
                message={serverSearch.message}
                quotaWaitMs={serverSearch.quotaWaitMs}
                online={online}
              />
            )}

            {searchOpen && !readerOpen && searchQuery.trim() && (
              <div
                data-testid="search-coverage"
                data-search-query={search.completedQuery ?? undefined}
                role={search.failed ? 'alert' : 'status'}
                className="flex h-8 flex-none items-center border-t border-edge px-7 text-[11px] text-ink-faint"
              >
                {search.failed
                  ? 'Local search could not be completed'
                  : search.response
                    ? searchCoverageText(search.response.coverage)
                    : 'Searching cached mail…'}
              </div>
            )}

            {readerOpen && selected && (
              <ConversationView
                selected={selected}
                selectedIndex={conversationSelectedIndex}
                threadCount={conversationThreadCount}
                threadCountExact={conversationThreadCountExact}
                mailboxTitle={searchOpen ? 'Search' : activeViewTitle}
                conversation={conversation}
                account={activeAccount}
                online={online}
                scrollRef={conversationScrollRef}
                inlineComposer={
                  inlineComposerDraft && activeAccount ? (
                    <Composer
                      key={inlineComposerDraft.id}
                      ref={inlineComposerRef}
                      account={activeAccount}
                      draft={inlineComposerDraft}
                      mode="inline"
                      initialError={composerError}
                      onClose={closeComposer}
                      onExit={closeComposerAndReader}
                      onToast={showToast}
                    />
                  ) : null
                }
                inlineComposerDraftId={inlineComposerDraft?.id ?? null}
                onClose={closeReader}
                onToast={showToast}
              />
            )}
          </div>
        </div>
      </div>

      {!fullWindowComposerDraft && (
        <MailFooter
          context={
            inlineComposerDraft
              ? 'composer'
              : searchOpen && searchKeyboardTarget === 'query' && !readerOpen
                ? 'search'
                : readerOpen
                  ? 'reader'
                  : !searchOpen && view === 'outbox'
                    ? 'outbox'
                    : 'list'
          }
          pendingChord={pendingChord}
          sync={sync}
          networkOnline={networkOnline}
          onRetry={retrySync}
          onCopyError={copySyncError}
        />
      )}

      {!composerDraft && snoozeOpen && selected && (
        <SnoozePicker
          targetCount={targetedThreads.length}
          onCancel={closeSnooze}
          onConfirm={snoozeSelected}
          onUnsnooze={view === 'snoozed' ? unsnoozeSelected : undefined}
        />
      )}

      {!composerDraft && labelTargets && (
        <LabelPicker
          labels={labels}
          targets={labelTargets.map((target) => ({ id: target.id, labelIds: target.labelIds }))}
          onClose={closeLabel}
          onToggle={toggleLabel}
        />
      )}

      {!composerDraft && moveRequest && (
        <MovePicker
          labels={labels}
          targets={moveRequest.targets}
          sourceLabelId={moveRequest.sourceLabelId}
          showImportanceActions={Boolean(
            !searchOpen &&
              view === 'inbox' &&
              splits.state?.splits.some((split) => split.id === IMPORTANT_SPLIT_ID) &&
              splits.state.splits.some((split) => split.id === OTHER_SPLIT_ID)
          )}
          onClose={closeMove}
          onMove={moveSelected}
        />
      )}

      {!composerDraft && splitRulesOpen && splits.state && (
        <SplitRuleManager
          state={splits.state}
          onSave={splits.save}
          onNotify={splits.setNotify}
          onDelete={splits.remove}
          onReorder={(ids) => splits.reorder({ ids })}
          onRestore={splits.restorePreset}
          onClose={() => setSplitRulesOpen(false)}
        />
      )}

      <CommandPalette
        key={activeAccount ?? 'signed-in'}
        account={activeAccount}
        context={composerDraft ? 'composer' : readerOpen ? 'reader' : view === 'outbox' ? 'outbox' : 'list'}
      />

      {fullWindowComposerDraft && activeAccount && (
        <Composer
          account={activeAccount}
          draft={fullWindowComposerDraft}
          initialError={composerError}
          onClose={closeComposer}
          onToast={showToast}
        />
      )}

      <Toast toast={toast} progress={outboxProgress} />
    </div>
  )
}
