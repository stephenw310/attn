import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, ThreadListView } from '../../../shared/mail'
import type { MoveDestination } from '../../../shared/move'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../../shared/splits'
import type { UpdateState } from '../../../shared/update'
import { readAccountView } from '../accountViewMemory'
import { Composer, type ComposerHandle } from '../composer/Composer'
import { useAccountSession } from '../hooks/useAccountSession'
import { useConversation } from '../hooks/useConversation'
import { useDraftOpening } from '../hooks/useDraftOpening'
import { useFocusThreadTarget } from '../hooks/useFocusThreadTarget'
import { useInboxCommands } from '../hooks/useInboxCommands'
import { isTextEntry, useKeyboardDispatch } from '../hooks/useKeyboardDispatch'
import { useMailData } from '../hooks/useMailData'
import { useSearchSession } from '../hooks/useSearchSession'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { useSelectionState } from '../hooks/useSelectionState'
import { useAccountSettings, useSettings } from '../hooks/useSettings'
import { useSettingsCommands } from '../hooks/useSettingsCommands'
import { useSplits } from '../hooks/useSplits'
import { useSyncActions } from '../hooks/useSyncActions'
import { useToast } from '../hooks/useToast'
import { useTriage } from '../hooks/useTriage'
import { useViewNavigation } from '../hooks/useViewNavigation'
import { useViewRecords } from '../hooks/useViewRecords'
import { type LabelCheckState, LabelPicker } from '../LabelPicker'
import { MovePicker, type MoveTarget } from '../MovePicker'
import {
  cachedThreadView,
  type DisplayThread,
  displaySnoozedThreads,
  displayThreads,
  type MailView,
  type PagedThreadView,
  userLabelId,
  userLabelView,
  VIEW_TITLES
} from '../mailDisplay'
import { selectionAfterExit } from '../optimisticTriage'
import {
  conversationMailboxFor,
  conversationMailboxForSearch,
  searchAllowsMove,
  triageViewForSearch
} from '../searchView'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../sidebarState'
import { ToastContext } from '../toastContext'
import { CheatSheet } from './CheatSheet'
import { CommandPalette } from './CommandPalette'
import { ConversationView, type MessageReplyTarget } from './ConversationView'
import { DraftList } from './DraftList'
import { InboxZero } from './InboxZero'
import { MailFooter } from './MailFooter'
import { MailHeader } from './MailHeader'
import { MailSidebar } from './MailSidebar'
import { OutboxList } from './OutboxList'
import { SearchHeader, searchCoverageText } from './SearchHeader'
import { ServerSearchRow } from './ServerSearchRow'
import { type SettingsControl, SettingsView } from './SettingsView'
import { SnoozePicker } from './SnoozePicker'
import { SplitRuleManager } from './SplitRuleManager'
import { SplitStrip } from './SplitStrip'
import { ThreadList } from './ThreadList'
import { Toast } from './Toast'

interface InboxProps {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
  /** Runs the reorder round trip above the keyed remount, with a supersession ticket (see App). */
  onReorderAccounts: (ids: string[]) => Promise<void>
  onRemovalError: (message: string) => void
  /** Claims the one announcement of a ready update, above the keyed remount (see App). */
  onClaimUpdateAnnouncement: (version: string) => boolean
}

interface MoveRequest {
  targets: readonly MoveTarget[]
  sourceLabelId: string | null
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

export function Inbox({
  status,
  onStatus,
  onReorderAccounts,
  onRemovalError,
  onClaimUpdateAnnouncement
}: InboxProps): React.JSX.Element {
  // The previous visit's snapshot for this account, saved by the guarded
  // switch before the tree remounted (F18: a warm switch restores the
  // account's last view, selection, and scroll). Read once per mount.
  const [restoredView] = useState(() => {
    const accountId = status.activeAccountId ?? status.email ?? null
    return accountId ? readAccountView(accountId) : null
  })
  const [view, setView] = useState<MailView>(() => restoredView?.view ?? 'inbox')
  // `activeViewRef` is the synchronous half of `view`: navigation, the record
  // store and useMailData all read the view inside the same event turn that
  // changes it, before React re-renders. `applyView` is the only writer of
  // either, so the two can never drift.
  const activeViewRef = useRef<MailView>(restoredView?.view ?? 'inbox')
  const applyView = useCallback((next: MailView) => {
    activeViewRef.current = next
    setView(next)
  }, [])
  const [pendingChord, setPendingChord] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed())
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [splitRulesOpen, setSplitRulesOpen] = useState(false)
  // Full-window settings view (F15): the prior list or reader stays mounted
  // and hidden; Esc or Back restores it exactly. The sidebar stays visible.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFocus, setSettingsFocus] = useState<SettingsControl | null>(null)
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false)
  // The palette can sit above the cheat sheet, and the sheet's capture-phase
  // handler runs first, so the sheet has to know when input belongs to the
  // palette. Lifted here rather than probed out of the DOM (P9).
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [labelTargetIds, setLabelTargetIds] = useState<readonly string[] | null>(null)
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null)
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null)
  const [detachedDraftThread, setDetachedDraftThread] = useState<DisplayThread | null>(null)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  const { settings: appSettings, update: updateAppSetting } = useSettings(showToast)
  const appSettingsRef = useRef(appSettings)
  appSettingsRef.current = appSettings
  const { accountSettings, updateAccountSetting } = useAccountSettings(
    status.activeAccountId ?? status.email ?? null,
    showToast
  )
  const autoAdvance = appSettings?.autoAdvanceDirection ?? 'next'
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectedDraftIdRef = useRef<string | null>(null)
  const listElRef = useRef<HTMLElement | null>(null)
  const loadedRowsRef = useRef(0)
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
  const settingsOpenRef = useRef(false)
  settingsOpenRef.current = settingsOpen
  const composerOpeningRef = useRef(false)
  // Switching or adding an account swaps (remounts) the whole mail surface,
  // which would drop an open composer's not-yet-autosaved keystrokes. The
  // keyboard and palette are already inert while composing; these guards and
  // the menu's disabled rows make the pointer path match. `Esc` saves and
  // closes the draft first (F6), so nothing is ever lost to a switch. The
  // guards read the ref, not the captured boolean: an OAuth completion can
  // arrive minutes after the closure was created, and only the ref knows
  // whether a composer is open *now*.
  const accountActionsBlocked = composerDraft !== null
  const composerOpenRef = useRef(false)
  composerOpenRef.current = accountActionsBlocked
  const draftOpenRequestRef = useRef(0)
  const draftOpenTargetRef = useRef<{ request: number; draftId: string; threadId: string } | null>(null)
  const inlineComposerRef = useRef<ComposerHandle | null>(null)
  const messageReplyTargetRef = useRef<MessageReplyTarget | null>(null)

  // The normalized account id — the key the utility uses for revert notices,
  // command usage, and every account-scoped row. `status.email` is display-only.
  const activeAccount = status.activeAccountId ?? status.email ?? null
  const splits = useSplits(activeAccount, restoredView?.splitId ?? null)
  const activeSplitIdRef = useRef(splits.activeSplitId)
  activeSplitIdRef.current = splits.activeSplitId
  const inboxSplitIdsKey = splits.state?.splits.map((split) => split.id).join('\u0000') ?? ''
  const inboxSplitRevision = splits.state?.revision
  const {
    sync,
    inboxBackfillReady,
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
    setMailboxSelectedIndex,
    splits.state !== null
  )
  const records = useViewRecords({
    account: activeAccount,
    restored: restoredView,
    view: activeViewRef,
    searchOpen: searchOpenRef,
    readerOpen: readerOpenRef,
    activeSplitId: activeSplitIdRef,
    listEl: listElRef,
    selectedIndex: selectedIndexRef,
    selectedThreadId: selectedThreadIdRef,
    selectedDraftId: selectedDraftIdRef,
    loadedRows: loadedRowsRef
  })
  const accounts = useAccountSession({
    status,
    onStatus,
    onRemovalError,
    showToast,
    composerOpen: composerOpenRef,
    composerOpening: composerOpeningRef,
    saveAccountSnapshot: records.saveAccountSnapshot
  })
  const accountSwitchPendingRef = accounts.accountSwitchPendingRef
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const online = networkOnline && sync.phase !== 'offline'
  const backingMailView = view === 'outbox' ? records.outboxReturn.current.view : view
  const backingCachedView = cachedThreadView(backingMailView)
  const activeInboxRowsReady =
    realThreads !== null && (!splits.state || loadedInboxSplitId === splits.activeSplitId)
  const activeInboxRowsResolved =
    activeInboxRowsReady && !(loadedInboxSplitStale && (realThreads?.length ?? 0) === 0)
  useEffect(() => {
    if (!activeAccount || !activeInboxRowsReady || !inboxSplitIdsKey || inboxSplitRevision === undefined) {
      return
    }
    // Let the visible rows paint and their conversation reads reach the utility
    // before speculative split queries, which may scan a large mailbox.
    let timer: number | undefined
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => preloadInboxSplits(inboxSplitIdsKey.split('\u0000')), 0)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeAccount, activeInboxRowsReady, inboxSplitIdsKey, inboxSplitRevision, preloadInboxSplits])
  const activeInboxSelectionReady = activeInboxRowsReady && !loadedInboxSplitStale
  const showInboxZero = Boolean(
    !searchOpen &&
      view === 'inbox' &&
      !readerOpen &&
      activeInboxRowsResolved &&
      inboxBackfillReady === true &&
      realThreads?.length === 0 &&
      splits.state &&
      splits.activeSplitId
  )
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
  // The two pickers that hang off the focused row: any navigation drops them.
  const closePickers = useCallback(() => {
    setSnoozeOpen(false)
    setLabelTargetIds(null)
  }, [])
  const closeMove = useCallback(() => setMoveRequest(null), [])
  // Leave search without restoring anything; the caller owns the restore.
  const leaveSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [])
  // Closing the reader invalidates any in-flight draft-open request, so a late
  // `draft:reopen` for the conversation just left cannot mount a composer.
  const finishReaderClose = useCallback(() => {
    draftOpenRequestRef.current += 1
    draftOpenTargetRef.current = null
    setReaderOpen(false)
    setDetachedDraftThread(null)
  }, [])
  const search = useSearchSession({
    open: searchOpen,
    setOpen: setSearchOpen,
    openRef: searchOpenRef,
    query: searchQuery,
    setQuery: setSearchQuery,
    view,
    account: activeAccount,
    mailRevision,
    mailChangeSource,
    online,
    labels,
    readerOpen,
    composerCovering: composerDraft !== null,
    records,
    setSelectedIndex,
    selectedIndex,
    finishReaderClose,
    closeMove,
    reconnectGoogle: accounts.reconnectGoogle,
    listElRef,
    readerOpenRef,
    selectedIndexRef,
    selectedThreadIdRef,
    selectedDraftIdRef
  })
  const searchResultQuery = search.resultQuery
  const searchDraftMode = search.draftMode
  const moveAllowed = searchOpen
    ? searchAllowsMove(searchResultQuery)
    : view !== 'drafts' && view !== 'snoozed' && view !== 'outbox'
  const threads = searchOpen ? search.threads : mailboxThreads
  loadedRowsRef.current = mailboxThreads.length
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
  const { selectedIds, clearSelection, toggleFocusedSelection, extendSelectionTo, extendSelectionBy } =
    useSelectionState(threads, selectedIndex, setSelectedIndex)

  // App keys this tree by account: transient state starts fresh on each mount,
  // while the saved view and split records above survive the round trip.

  // T39: a ready update surfaces once as a quiet toast; the palette command
  // applies it through the awaited shutdown, and nothing forces a restart. The
  // dedupe lives in App, above this account-keyed tree, so switching accounts
  // does not re-announce an update the user has already seen.
  useEffect(() => {
    const announce = (state: UpdateState): void => {
      if (state.phase !== 'ready' || state.readyVersion === null) return
      if (!onClaimUpdateAnnouncement(state.readyVersion)) return
      showToast(`Update ${state.readyVersion} ready — it applies on quit, or Restart to update`)
    }
    // Subscribe first, then read: a download that finished while no window
    // existed still gets announced, and the shared dedupe drops the overlap
    // when a broadcast races the read (PR #101 review).
    const unsubscribe = window.attn?.update.onState(announce)
    void window.attn?.update
      .getState()
      .then(announce)
      .catch(() => {})
    return unsubscribe
  }, [onClaimUpdateAnnouncement, showToast])

  // T37 AI reply drafting: one Inbox-owned command serves the reader and the
  // composer. An invocation parks in the pending ref until the (possibly just
  // opened) reply composer's plugin claims it — claiming is one-shot, so a
  // remounted composer can never replay a consumed invocation. The pending
  // value is the target THREAD id: a composer for any other conversation
  // finds nothing to claim, so an invocation can never carry into an
  // unrelated draft (PR #101 review).
  useEffect(() => {
    const visibleCount = searchDraftMode
      ? search.drafts.length
      : searchOpen
        ? threads.length
        : view === 'drafts'
          ? realDrafts.length
          : view === 'outbox'
            ? realOutbox.length
            : threads.length
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(visibleCount - 1, 0))))
    if ((searchOpen || view !== 'drafts') && threads.length === 0) setReaderOpen(false)
  }, [realDrafts.length, realOutbox.length, searchDraftMode, search.drafts.length, searchOpen, threads, view])

  const selected = detachedDraftThread ?? threads[selectedIndex]
  // Split and mailbox switches snapshot selection synchronously inside the same
  // key turn that can move the cursor. Mirror the visible thread id at render
  // time so a fast ArrowDown → split switch saves the new row, not the prior one.
  if (!searchOpen && view !== 'drafts' && view !== 'outbox') {
    selectedThreadIdRef.current = selected?.id ?? null
  }
  const conversationThreads = detachedDraftThread ? [detachedDraftThread] : threads
  const conversationSelectedIndex = detachedDraftThread ? 0 : selectedIndex

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed)
  }, [sidebarCollapsed])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  const openSettings = useCallback(
    (control: SettingsControl | null = null) => {
      // Settings hides the mail surface, so a composer would keep running
      // invisibly underneath — including one whose create round trip is still
      // in flight, which would mount under Settings and still receive
      // composer keys (PR #101 review: Mod+Enter from Settings sent the
      // hidden reply). Same refusal the account actions use.
      if (composerOpenRef.current || composerOpeningRef.current) {
        showToast('Save and close the draft before opening Settings')
        return
      }
      settingsOpenRef.current = true
      setSettingsFocus(control)
      setSettingsOpen(true)
    },
    [showToast]
  )
  const closeSettings = useCallback(() => {
    settingsOpenRef.current = false
    setSettingsOpen(false)
    setSettingsFocus(null)
  }, [])

  // Settings Esc rides the bubble phase: overlays that own Escape (palette,
  // cheat sheet, remove-account dialog) consume it during capture, and the
  // split manager's own bubble listener is excluded by the guard here.
  useEffect(() => {
    if (!settingsOpen || splitRulesOpen || accounts.removeAccountOpen || cheatSheetOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Escape inside a Settings field cancels that edit; closing Settings from
      // under the cursor would discard the snippet or rule being typed (B9).
      if (isTextEntry(event.target)) return
      event.preventDefault()
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cheatSheetOpen, closeSettings, accounts.removeAccountOpen, settingsOpen, splitRulesOpen])

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
  // Read at invocation, not captured at registration: both flip as the focused
  // row moves, and the command batch must not churn with it (P1).
  const starOnRef = useRef(false)
  starOnRef.current = targetedThreads.some((thread) => !thread.starred)
  const markUnreadOnRef = useRef(false)
  markUnreadOnRef.current = targetedThreads.some((thread) => !thread.unread)
  // Stable views of the focused row for the command batch and the AI-draft
  // command, both of which must not re-register as the cursor moves.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const drafting = useDraftOpening({
    account: activeAccount,
    view,
    viewRef: activeViewRef,
    searchOpen,
    searchOpenRef,
    searchResultQuery,
    readerOpen,
    readerOpenRef,
    selected,
    selectedRef,
    conversation,
    messageReplyTargetRef,
    composerDraft,
    setComposerDraft,
    composerError,
    setComposerError,
    setDetachedDraftThread,
    realThreads,
    realSnoozedThreads,
    realDrafts,
    realOutbox,
    selectedIndex,
    accountSwitchPendingRef,
    composerOpeningRef,
    draftOpenRequestRef,
    draftOpenTargetRef,
    inlineComposerRef,
    selectedThreadIdRef,
    selectedDraftIdRef,
    settingsOpenRef,
    applyView,
    clearSelection,
    setSelectedIndex,
    setReaderOpen,
    closePickers,
    finishReaderClose,
    invalidateConversations,
    refreshMailRows,
    refreshDrafts,
    showToast
  })
  const {
    reopenDraftForThread,
    reopenListDraft,
    openOutboxItem,
    openComposer,
    openReply,
    inlineComposerDraft,
    fullWindowComposerDraft
  } = drafting

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
  const navigation = useViewNavigation({
    view,
    viewRef: activeViewRef,
    applyView,
    records,
    splits,
    inlineComposerRef,
    searchOpenRef,
    closeSearch: leaveSearch,
    viewRowsLoaded,
    threads,
    mailboxThreads,
    realThreads,
    realDrafts,
    realOutbox,
    pagedView,
    activePageState,
    threadPagination,
    loadMoreThreads,
    loadedInboxSplitId,
    loadedInboxSplitStale,
    activateInboxSplitCache,
    inboxSplitRevision,
    mailRevision,
    selectedIndex,
    readerOpen,
    clearSelection,
    invalidateConversations,
    refreshCachedThreadView,
    setSelectedIndex,
    setReaderOpen,
    closePickers,
    closeMove,
    closeSettings,
    setDetachedDraftThread,
    listElRef,
    selectedIndexRef,
    readerOpenRef,
    selectedThreadIdRef,
    selectedDraftIdRef
  })
  const { switchView, switchSplit, moveSplit, openOutbox, closeOutbox } = navigation

  useFocusThreadTarget({
    account: activeAccount,
    splitsReady: splits.state !== null,
    setActiveSplitId: splits.setActiveSplitId,
    focusInboxThread,
    switchView,
    switchAccount: accounts.switchAccount,
    clearSelection,
    cancelPendingRestores: navigation.cancelPendingRestores,
    setSelectedIndex,
    setReaderOpen,
    setDetachedDraftThread,
    selectedThreadIdRef
  })

  // The inverse of 'Back to list' auto-advance, for a triage write that is
  // rejected outright: the rollback restores rows and selection, and this
  // restores the reader the advance closed.
  const reopenReaderForAdvance = useCallback(() => setReaderOpen(true), [])

  const { triage, exitingThreadIds } = useTriage({
    selectedIds,
    selectedIndex,
    threads,
    readerOpen,
    view: searchOpen ? triageViewForSearch(searchResultQuery) : view,
    activeSplitId: searchOpen ? null : splits.activeSplitId,
    searchOpen,
    searchMoveRetains: searchOpen ? search.moveRetains : undefined,
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
    updateSearchRows: searchOpen ? search.updateRows : undefined,
    clearSelection,
    showToast,
    setSelectedIndex,
    autoAdvance,
    closeReader: finishReaderClose,
    reopenReader: reopenReaderForAdvance
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

  const openSelected = useCallback(() => {
    if (searchDraftMode) {
      const draft = search.drafts[selectedIndex]
      if (!draft) return
      reopenListDraft(draft.id)
      return
    }
    if (!searchOpen && view === 'outbox') {
      openOutboxItem(selectedIndex)
      return
    }
    if (!searchOpen && view === 'drafts') {
      const draft = realDrafts[selectedIndex]
      if (!draft) return
      reopenListDraft(draft.id)
      return
    }
    const thread = threads[selectedIndex]
    if (!thread) return
    if (!searchOpen) {
      records.viewRecords.current.set(view, {
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
    reopenListDraft,
    searchDraftMode,
    search.drafts,
    searchOpen,
    selectedIndex,
    threads,
    view,
    records.viewRecords.current.set
  ])
  const closeReader = useCallback(() => {
    if (inlineComposerDraft && inlineComposerRef.current) {
      inlineComposerRef.current.exitConversation()
      return
    }
    finishReaderClose()
  }, [finishReaderClose, inlineComposerDraft])
  // The search session hands the selection back to the list it covered, so
  // clearing it stays with the shell that owns it.
  const focusSearchQuery = useCallback(() => {
    clearSelection()
    search.focusQuery()
  }, [clearSelection, search.focusQuery])
  const openSearch = useCallback(() => {
    clearSelection()
    search.openSearch()
  }, [clearSelection, search.openSearch])
  const clearSearch = useCallback(() => {
    clearSelection()
    search.clearSearch()
  }, [clearSelection, search.clearSearch])
  const closeSnooze = useCallback(() => setSnoozeOpen(false), [])
  const closeLabel = useCallback(() => setLabelTargetIds(null), [])
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
        records.viewRecords.current.set(view, {
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
    [reopenDraftForThread, searchOpen, threads, view, records.viewRecords.current.set]
  )
  // ThreadList and ConversationView are memoized, so every prop they take has
  // to keep its identity across renders they do not care about — a sync push
  // must not re-render a mounted Lexical tree (P3).
  const openLabelView = useCallback((labelId: string) => switchView(userLabelView(labelId)), [switchView])
  const openThreadFromList = useCallback(
    (index: number) => {
      if (searchOpen) search.focusResults()
      openThread(index)
    },
    [openThread, search.focusResults, searchOpen]
  )
  const snoozeSelected = useCallback(
    (dueAt: number) => {
      if (!window.attn || !selected) return
      const isBulk = selectedIds.size > 0
      const threadIds = isBulk ? [...selectedIds] : [selected.id]
      closeSnooze()
      if (isBulk) clearSelection()
      // Snooze removes rows on refresh rather than optimistically, so the
      // default 'next' advance is free (index preservation). The other two
      // directions retarget before the refresh lands (F3 auto-advance).
      if (!searchOpen && view !== 'snoozed') {
        if (readerOpen && autoAdvance === 'list') finishReaderClose()
        else if (autoAdvance === 'previous') {
          const selection = selectionAfterExit(threads, threadIds, selectedIndex, 'previous')
          if (selection && selection.toId !== null && selection.toId !== selection.fromId) {
            selectedThreadIdRef.current = selection.toId
            setSelectedIndex(Math.max(0, selection.nextIndex))
          }
        }
      }
      void window.attn.mail
        .snooze(threadIds, dueAt)
        .then((result) => showToast(result.label))
        .catch(() => {})
    },
    [
      autoAdvance,
      clearSelection,
      closeSnooze,
      finishReaderClose,
      readerOpen,
      searchOpen,
      selected,
      selectedIds,
      selectedIndex,
      showToast,
      threads,
      view
    ]
  )

  const unsnoozeSelected = useCallback(() => {
    if (!selected) return
    closeSnooze()
    triage({ kind: 'unsnooze', threadIds: [selected.id] })
  }, [closeSnooze, selected, triage])

  const visibleRowCount = searchDraftMode
    ? search.drafts.length
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
    hasSelection: selected !== undefined,
    selectedRef,
    selectedCount: selectedIds.size,
    readerOpen,
    view,
    searchOpen,
    searchBrowsing: searchOpen && search.keyboardTarget === 'results' && !readerOpen,
    sidebarCollapsed,
    starOnRef,
    markUnreadOnRef,
    moveAllowed,
    preserveSelectionOnRefreshRef,
    navigateNext,
    navigatePrevious,
    clearSelection,
    toggleSelection: toggleFocusedSelection,
    extendSelectionBy,
    openSelected,
    closeReader,
    switchView,
    openOutbox,
    closeOutbox,
    discardSelectedDraft: !searchOpen && view === 'drafts' ? drafting.discardSelectedDraft : null,
    toggleSidebar,
    openSearch,
    focusSearchQuery,
    searchAllEnabled:
      !searchDraftMode &&
      !search.snoozeMode &&
      Boolean(searchQuery.trim()) &&
      online &&
      search.server.phase !== 'waiting' &&
      search.server.phase !== 'complete',
    submitSearch: search.submit,
    clearSearch,
    triage,
    openSnooze,
    snoozeAt: snoozeSelected,
    openLabel,
    openMove,
    markNotDone,
    openComposer,
    openReply,
    openMessageOrReplyAll: drafting.openMessageOrReplyAll,
    showToast,
    reopenUndoDraft: drafting.reopenUndoDraft,
    splitCommands,
    accountCommands: accounts.accountCommands
  })

  const openCheatSheet = useCallback(() => setCheatSheetOpen(true), [])
  const closeCheatSheet = useCallback(() => setCheatSheetOpen(false), [])
  useSettingsCommands({
    settings: appSettings,
    openSettings,
    openCheatSheet,
    updateAppSetting,
    updateAccountSetting,
    requestAiDraft: drafting.requestAiDraftCommand,
    showToast
  })

  useKeyboardDispatch({
    blocked:
      labelTargets !== undefined ||
      moveRequest !== null ||
      composerDraft !== null ||
      splitRulesOpen ||
      accounts.removeAccountOpen ||
      settingsOpen ||
      cheatSheetOpen ||
      accounts.accountSwitchPending,
    readerOpen,
    outboxOpen: !searchOpen && view === 'outbox',
    snoozeOpen,
    onCloseSnooze: closeSnooze,
    viewKey: `${view}:${readerOpen ? 'reader' : 'list'}:${
      searchOpen ? search.keyboardTarget : 'mail'
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
    <ToastContext.Provider value={showToast}>
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
          accountStatuses={accounts.accountStatuses}
          onReconnectActions={accounts.reconnectActions}
          onOpenOutbox={openOutbox}
          onToggleSidebar={toggleSidebar}
          onSwitchAccount={accounts.switchAccount}
          onAddAccount={accounts.addAccount}
          onRemoveAccount={accounts.requestRemoveAccount}
          onOpenSettings={() => openSettings(null)}
          onOpenCheatSheet={openCheatSheet}
          accountActionsBlocked={accountActionsBlocked}
        />

        {accounts.removeAccountDialog}

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
          {settingsOpen && activeAccount && (
            <SettingsView
              status={status}
              accountStatuses={accounts.accountStatuses}
              settings={appSettings}
              accountSettings={accountSettings}
              onUpdateSetting={updateAppSetting}
              onUpdateAccountSetting={updateAccountSetting}
              onReorderAccounts={onReorderAccounts}
              onAddAccount={accounts.addAccount}
              onReconnect={accounts.reconnectActions}
              onSignOut={accounts.requestRemoveAccount}
              onClose={closeSettings}
              focusControl={settingsFocus}
            />
          )}
          <div
            className={`min-w-0 flex-1 flex-col ${settingsOpen ? 'hidden' : 'flex'}`}
            aria-hidden={settingsOpen || undefined}
          >
            {!readerOpen &&
              !fullWindowComposerDraft &&
              (searchOpen ? (
                <SearchHeader
                  inputRef={search.inputRef}
                  query={searchQuery}
                  pending={search.local.pending}
                  onQuery={setSearchQuery}
                  onClear={clearSearch}
                  onFocusQuery={focusSearchQuery}
                  onSubmit={search.submit}
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
                  drafts={search.drafts}
                  readerOpen={false}
                  selectedIndex={selectedIndex}
                  selectionVisible={search.keyboardTarget === 'results'}
                  selectedRowRef={selectedRowRef}
                  listRef={listElRef}
                  onOpen={(index) => {
                    search.focusResults()
                    setSelectedIndex(index)
                    const draft = search.drafts[index]
                    if (draft) reopenListDraft(draft.id)
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
                    if (!draft) return
                    selectedDraftIdRef.current = draft.id
                    reopenListDraft(draft.id)
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
              ) : showInboxZero && splits.state && splits.activeSplitId ? (
                <InboxZero
                  activeSplitId={splits.activeSplitId}
                  splits={splits.state.splits}
                  listRef={listElRef}
                  onSelectSplit={switchSplit}
                />
              ) : (
                <ThreadList
                  threads={threads}
                  view={searchOpen ? 'search' : threadListKind(view)}
                  hasMore={
                    !searchOpen && activePageState?.nextCursor !== null && activePageState !== undefined
                  }
                  loadingMore={!searchOpen && (activePageState?.loadingMore ?? false)}
                  loadingInitial={
                    !searchOpen &&
                    view === 'inbox' &&
                    (!activeInboxRowsResolved || inboxBackfillReady !== true)
                  }
                  syncing={!searchOpen && sync.phase === 'syncing'}
                  readerOpen={readerOpen}
                  selectedIndex={selectedIndex}
                  selectionVisible={!searchOpen || search.keyboardTarget === 'results'}
                  selectedIds={selectedIds}
                  exitingThreadIds={exitingThreadIds}
                  labelsById={userLabelsById}
                  selectedRowRef={selectedRowRef}
                  listRef={listElRef}
                  onExtendSelection={extendSelectionTo}
                  onLoadMore={loadMoreVisibleThreads}
                  onOpenLabel={openLabelView}
                  onOpen={openThreadFromList}
                  sectionDivider={searchOpen ? search.sectionDivider : undefined}
                />
              )}

              {searchOpen && !readerOpen && !searchDraftMode && !search.snoozeMode && searchQuery.trim() && (
                <ServerSearchRow
                  phase={search.server.phase}
                  resultCount={search.server.resultCount}
                  message={search.server.message}
                  quotaWaitMs={search.server.quotaWaitMs}
                  online={online}
                />
              )}

              {searchOpen && !readerOpen && searchQuery.trim() && (
                <div
                  data-testid="search-coverage"
                  data-search-query={search.local.completedQuery ?? undefined}
                  role={search.local.failed ? 'alert' : 'status'}
                  data-partial={search.local.response?.partial || undefined}
                  className={`flex h-8 flex-none items-center border-t border-edge px-7 text-[11px] ${
                    search.local.response?.partial ? 'text-accent' : 'text-ink-faint'
                  }`}
                >
                  {search.local.failed
                    ? 'Local search could not be completed'
                    : search.local.response
                      ? searchCoverageText(search.local.response.coverage, search.local.response.partial)
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
                  replyTargetRef={messageReplyTargetRef}
                  inlineComposer={drafting.inlineComposer}
                  inlineComposerDraftId={inlineComposerDraft?.id ?? null}
                  inlineComposerSourceMessageId={inlineComposerDraft?.sourceMessageId ?? null}
                  onReply={openReply}
                  onClose={closeReader}
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
                : searchOpen && search.keyboardTarget === 'query' && !readerOpen
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
          account={activeAccount}
          context={composerDraft ? 'composer' : readerOpen ? 'reader' : view === 'outbox' ? 'outbox' : 'list'}
          onOpenChange={setPaletteOpen}
        />

        <CheatSheet
          open={cheatSheetOpen}
          paletteOpen={paletteOpen}
          onOpen={openCheatSheet}
          onClose={closeCheatSheet}
        />

        {fullWindowComposerDraft && activeAccount && (
          <Composer
            draft={fullWindowComposerDraft}
            initialError={composerError}
            onClose={drafting.closeComposer}
            onToast={showToast}
          />
        )}

        <Toast toast={toast} progress={outboxProgress} />
      </div>
    </ToastContext.Provider>
  )
}
