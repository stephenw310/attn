import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import type { UpdateState } from '../../../shared/distribution'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, ThreadListView } from '../../../shared/mail'
import { readAccountView } from '../accountViewMemory'
import { getCommandRegistrySnapshot } from '../commands'
import type { MessageReplyTarget } from '../components/ConversationView'
import type { SettingsControl } from '../components/SettingsView'
import type { ComposerHandle } from '../composer/Composer'
import { readFooterCollapsed, writeFooterCollapsed } from '../footerState'
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
} from '../list/mailDisplay'
import {
  conversationMailboxFor,
  conversationMailboxForSearch,
  searchAllowsMove,
  triageViewForSearch
} from '../searchView'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../sidebarState'
import { useAccountSession } from './useAccountSession'
import { useConversation } from './useConversation'
import { useDraftOpening } from './useDraftOpening'
import { useFocusThreadTarget } from './useFocusThreadTarget'
import { useInboxCommands } from './useInboxCommands'
import { isTextEntry, useKeyboardDispatch } from './useKeyboardDispatch'
import { type MoveRequest, useListActions } from './useListActions'
import { useMailData } from './useMailData'
import { useSearchSession } from './useSearchSession'
import { useSelectionState } from './useSelectionState'
import { useAccountSettings, useSettings } from './useSettings'
import { useSettingsCommands } from './useSettingsCommands'
import { useSplits } from './useSplits'
import { useSyncActions } from './useSyncActions'
import { useToast } from './useToast'
import { useTriage } from './useTriage'
import { useViewNavigation } from './useViewNavigation'
import { useViewRecords } from './useViewRecords'

export interface InboxProps {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
  /** Runs the reorder round trip above the keyed remount, with a supersession ticket (see App). */
  onReorderAccounts: (ids: string[]) => Promise<void>
  onRemovalError: (message: string) => void
  /** Claims the one announcement of a ready update, above the keyed remount (see App). */
  onClaimUpdateAnnouncement: (version: string) => boolean
}

function titleForView(view: MailView, labelsById: ReadonlyMap<string, MailLabel>): string {
  const labelId = userLabelId(view)
  if (labelId) return labelsById.get(labelId)?.name ?? 'Label'
  return VIEW_TITLES[view as keyof typeof VIEW_TITLES]
}

export function useInboxController({
  status,
  onStatus,
  onReorderAccounts,
  onRemovalError,
  onClaimUpdateAnnouncement
}: InboxProps) {
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
  const [footerCollapsed, setFooterCollapsed] = useState(() => readFooterCollapsed())
  useEffect(() => writeFooterCollapsed(footerCollapsed), [footerCollapsed])
  const toggleFooter = useCallback(() => setFooterCollapsed((collapsed) => !collapsed), [])
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
  // The synchronous halves of the shell's own state: the extracted hooks read
  // the cursor, the reader and the settings surface inside the same event turn
  // that changes them, before React re-renders.
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
    focusMailboxThread,
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realMailboxCounts,
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

  // The cursor can never point past the visible list, however the list got
  // shorter — a refresh, a triage removal, or a narrowing search.
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
      setSplitRulesOpen(false)
      settingsOpenRef.current = true
      setSettingsFocus(control)
      setSettingsOpen(true)
    },
    [showToast]
  )
  const clearSettingsFocus = useCallback(() => setSettingsFocus(null), [])
  const closeSplitRules = useCallback(() => setSplitRulesOpen(false), [])
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
    closeSplitRules,
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
    focusMailboxThread,
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

  const listActions = useListActions({
    view,
    searchOpen,
    searchDraftMode,
    searchDrafts: search.drafts,
    threads,
    realDrafts,
    realOutbox,
    selectedIndex,
    selected,
    selectedIds,
    targetedThreads,
    detachedDraftThread,
    readerOpen,
    moveAllowed,
    autoAdvance,
    labelTargets,
    moveRequest,
    triage,
    records,
    inlineComposerRef,
    listElRef,
    selectedThreadIdRef,
    setSelectedIndex,
    setReaderOpen,
    setSnoozeOpen,
    setLabelTargetIds,
    setMoveRequest,
    setDetachedDraftThread,
    finishReaderClose,
    clearSelection,
    reopenDraftForThread,
    reopenListDraft,
    openOutboxItem,
    focusSearchResults: search.focusResults,
    showToast
  })
  const {
    openSelected,
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
  } = listActions

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
  // ThreadList and ConversationView are memoized, so every prop they take has
  // to keep its identity across renders they do not care about — a sync push
  // must not re-render a mounted Lexical tree (P3).
  const openLabelView = useCallback((labelId: string) => switchView(userLabelView(labelId)), [switchView])
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
    footerCollapsed,
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
    toggleFooter,
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

  useEffect(() => {
    if (!outboxFailure) return
    showToast(outboxFailure.error)
    clearOutboxFailure()
  }, [clearOutboxFailure, outboxFailure, showToast])

  const cancelFollowUpSelected = useCallback(() => {
    const current = selectedRef.current
    if (current) triage({ kind: 'cancelFollowUp', threadIds: [current.id] })
  }, [triage])

  const undoFromToast = useCallback(() => {
    if (composerOpenRef.current || composerOpeningRef.current || accountSwitchPendingRef.current) return
    getCommandRegistrySnapshot()
      .find((command) => command.id === 'triage.undo')
      ?.run()
  }, [accountSwitchPendingRef])

  return {
    openSnooze,
    undoFromToast,
    status,
    onReorderAccounts,
    view,
    searchOpen,
    searchQuery,
    setSearchQuery,
    footerCollapsed,
    sidebarCollapsed,
    selectedIndex,
    setSelectedIndex,
    readerOpen,
    snoozeOpen,
    splitRulesOpen,
    setSplitRulesOpen,
    settingsOpen,
    settingsFocus,
    clearSettingsFocus,
    cheatSheetOpen,
    paletteOpen,
    setPaletteOpen,
    composerDraft,
    composerError,
    toast,
    showToast,
    appSettings,
    updateAppSetting,
    accountSettings,
    updateAccountSetting,
    selectedRowRef,
    selectedDraftIdRef,
    listElRef,
    messageReplyTargetRef,
    activeAccount,
    splits,
    sync,
    inboxBackfillReady,
    networkOnline,
    activeInboxRowsResolved,
    viewRowsLoaded,
    realDrafts,
    realOutbox,
    realMailboxCounts,
    labels,
    pendingActionCount,
    pausedActionCount,
    accounts,
    userLabelsById,
    online,
    showInboxZero,
    search,
    searchDraftMode,
    threads,
    activeViewTitle,
    activePageState,
    conversationThreadCount,
    conversationThreadCountExact,
    loadMoreVisibleThreads,
    selectedIds,
    extendSelectionTo,
    selected,
    conversationSelectedIndex,
    conversation,
    conversationScrollRef,
    targetedThreads,
    drafting,
    reopenListDraft,
    openOutboxItem,
    inlineComposerDraft,
    fullWindowComposerDraft,
    exitingThreadIds,
    openThreadFromList,
    closeReader,
    snoozeSelected,
    unsnoozeSelected,
    cancelFollowUpSelected,
    toggleLabel,
    switchView,
    switchSplit,
    openOutbox,
    closeSnooze,
    closeLabel,
    closeMove,
    moveSelected,
    openSearch,
    clearSearch,
    focusSearchQuery,
    openLabelView,
    openReply,
    toggleFooter,
    toggleSidebar,
    openSettings,
    closeSettings,
    openCheatSheet,
    closeCheatSheet,
    retrySync,
    copySyncError,
    labelTargets,
    moveRequest,
    accountActionsBlocked,
    pendingChord,
    outboxProgress
  }
}

export type InboxController = ReturnType<typeof useInboxController>
