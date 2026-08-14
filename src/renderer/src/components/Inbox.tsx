import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import { type Draft, emptyDraftInput } from '../../../shared/drafts'
import type { MailLabel } from '../../../shared/mail'
import { Composer } from '../composer/Composer'
import { useConversation } from '../hooks/useConversation'
import { useInboxCommands } from '../hooks/useInboxCommands'
import { useKeyboardDispatch } from '../hooks/useKeyboardDispatch'
import { useMailData } from '../hooks/useMailData'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { useSelectionState } from '../hooks/useSelectionState'
import { useSyncActions } from '../hooks/useSyncActions'
import { useToast } from '../hooks/useToast'
import { useTriage } from '../hooks/useTriage'
import { type LabelCheckState, LabelPicker } from '../LabelPicker'
import { type DisplayThread, displaySnoozedThread, displayThread } from '../mailDisplay'
import { ConversationView } from './ConversationView'
import { MailFooter } from './MailFooter'
import { MailHeader } from './MailHeader'
import { SnoozePicker } from './SnoozePicker'
import { ThreadList } from './ThreadList'
import { Toast } from './Toast'

interface InboxProps {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}

export function Inbox({ status, onStatus }: InboxProps): React.JSX.Element {
  const [view, setView] = useState<'inbox' | 'snoozed'>('inbox')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null)
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null)
  const [toast, showToast] = useToast()
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const activeViewRef = useRef<'inbox' | 'snoozed'>('inbox')
  const earliestExitIndexRef = useRef<number | null>(null)
  const resetAccountRef = useRef<string | null | undefined>(undefined)
  const composerOpeningRef = useRef(false)

  const activeAccount = status.email ?? null
  const {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    realUnreadTotal,
    labels,
    pendingCount,
    mailRevision,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  } = useMailData(activeAccount, activeViewRef, selectedThreadIdRef, setSelectedIndex)
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const threads: DisplayThread[] = useMemo(
    () =>
      view === 'inbox'
        ? (realThreads ?? []).map(displayThread)
        : (realSnoozedThreads ?? []).map(displaySnoozedThread),
    [realSnoozedThreads, realThreads, view]
  )
  const { selectedIds, clearSelection, resetSelection, toggleFocusedSelection, extendSelectionTo } =
    useSelectionState(threads, selectedIndex, setSelectedIndex)

  // Account-scoped UI state has one reset owner. New transient surfaces, such
  // as the M2 composer, join this block rather than growing another effect.
  useEffect(() => {
    if (resetAccountRef.current === activeAccount) return
    resetAccountRef.current = activeAccount
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
    setComposerDraft(null)
    setExitingThreadIds(new Set())
    selectedThreadIdRef.current = null
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
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(threads.length - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    if (threads.length === 0) setReaderOpen(false)
  }, [threads])

  const selected = threads[selectedIndex]
  const { conversation, scrollRef: conversationScrollRef } = useConversation({
    selected,
    selectedIndex,
    threads,
    readerOpen,
    account: activeAccount,
    mailRevision
  })
  const targetedThreads =
    selectedIds.size > 0 ? threads.filter((thread) => selectedIds.has(thread.id)) : selected ? [selected] : []
  const starOn = targetedThreads.some((thread) => !thread.starred)
  const markUnreadOn = targetedThreads.some((thread) => !thread.unread)

  // The label picker targets a thread by id, not by list position: a refresh can
  // reorder or drop rows underneath an open picker.
  const labelTarget = useMemo(
    () => (labelTargetId === null ? undefined : threads.find((thread) => thread.id === labelTargetId)),
    [labelTargetId, threads]
  )

  useEffect(() => {
    if (labelTargetId !== null && !labelTarget) setLabelTargetId(null)
  }, [labelTarget, labelTargetId])

  useEffect(() => {
    selectedThreadIdRef.current = selected?.id ?? null
  }, [selected?.id])

  const { retrySync, copySyncError } = useSyncActions(sync, showToast)

  const switchView = useCallback((next: 'inbox' | 'snoozed') => {
    activeViewRef.current = next
    selectedThreadIdRef.current = null
    setView(next)
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
  }, [])

  useEffect(() => {
    if (!window.attn || !activeAccount) return
    return window.attn.mail.onFocusThread((threadId) => {
      // Close the old reader before changing lists so auto-read cannot observe
      // an old cursor against Inbox and mutate the wrong thread.
      switchView('inbox')
      clearSelection()
      void window.attn?.mail
        .listThreads()
        .then((nextThreads) => {
          const nextIndex = nextThreads.findIndex((thread) => thread.id === threadId)
          setRealThreads(nextThreads)
          if (nextIndex < 0) return
          selectedThreadIdRef.current = threadId
          setSelectedIndex(nextIndex)
          setReaderOpen(true)
        })
        .catch(() => {})
    })
  }, [activeAccount, clearSelection, setRealThreads, switchView])

  const triage = useTriage({
    selectedIds,
    selectedIndex,
    threadCount: threads.length,
    readerOpen,
    view,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    earliestExitIndexRef,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex
  })

  const toggleLabel = useCallback(
    (label: MailLabel, state: LabelCheckState) => {
      if (!labelTarget) return
      triage({
        kind: 'label',
        threadIds: [labelTarget.id],
        add: state === 'all' ? [] : [label.id],
        remove: state === 'all' ? [label.id] : []
      })
    },
    [labelTarget, triage]
  )

  const openSelected = useCallback(() => {
    if (threads[selectedIndex]) setReaderOpen(true)
  }, [selectedIndex, threads])
  const closeReader = useCallback(() => setReaderOpen(false), [])
  const closeSnooze = useCallback(() => setSnoozeOpen(false), [])
  const closeLabel = useCallback(() => setLabelTargetId(null), [])
  const openSnooze = useCallback(() => {
    if (selected) setSnoozeOpen(true)
  }, [selected])
  const openLabel = useCallback(() => {
    if (selected) setLabelTargetId(selected.id)
  }, [selected])
  const openThread = useCallback((index: number) => {
    setSelectedIndex(index)
    setReaderOpen(true)
  }, [])
  const openComposer = useCallback(() => {
    if (!window.attn || composerDraft || composerOpeningRef.current) return
    composerOpeningRef.current = true
    void window.attn.draft
      .save(emptyDraftInput())
      .then(({ id }) => window.attn?.draft.get(id) ?? null)
      .then((draft) => {
        if (draft) setComposerDraft(draft)
      })
      .catch(() => {})
      .finally(() => {
        composerOpeningRef.current = false
      })
  }, [composerDraft])

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

  useInboxCommands({
    threadCount: threads.length,
    selected,
    selectedCount: selectedIds.size,
    selectedIndex,
    readerOpen,
    view,
    starOn,
    markUnreadOn,
    preserveSelectionOnRefreshRef,
    setSelectedIndex,
    clearSelection,
    toggleSelection: toggleFocusedSelection,
    extendSelection: extendSelectionTo,
    openSelected,
    closeReader,
    switchView,
    triage,
    openSnooze,
    openLabel,
    openComposer,
    showToast
  })

  useKeyboardDispatch({
    blocked: labelTarget !== undefined || composerDraft !== null,
    readerOpen,
    snoozeOpen,
    onCloseSnooze: closeSnooze,
    conversationScrollRef
  })

  useSelectedRowScroll(selectedRowRef, selectedIndex, readerOpen)

  return (
    <div className="flex h-full flex-col">
      <MailHeader
        view={view}
        unreadCount={realUnreadTotal}
        pendingCount={pendingCount}
        selectionCount={selectedIds.size}
        status={status}
        onStatus={onStatus}
        onSwitchView={switchView}
      />

      <div className="flex min-h-0 flex-1">
        <ThreadList
          threads={threads}
          view={view}
          syncing={sync.phase === 'syncing'}
          readerOpen={readerOpen}
          selectedIndex={selectedIndex}
          selectedIds={selectedIds}
          exitingThreadIds={exitingThreadIds}
          labelsById={userLabelsById}
          selectedRowRef={selectedRowRef}
          onExtendSelection={extendSelectionTo}
          onOpen={openThread}
        />

        {readerOpen && selected && (
          <ConversationView
            selected={selected}
            selectedIndex={selectedIndex}
            threadCount={threads.length}
            view={view}
            conversation={conversation}
            account={activeAccount}
            scrollRef={conversationScrollRef}
            onClose={closeReader}
            onToast={showToast}
          />
        )}
      </div>

      {snoozeOpen && selected && (
        <SnoozePicker
          targetCount={targetedThreads.length}
          onCancel={closeSnooze}
          onConfirm={snoozeSelected}
          onUnsnooze={view === 'snoozed' ? unsnoozeSelected : undefined}
        />
      )}

      {labelTarget && (
        <LabelPicker
          labels={labels}
          targets={[{ id: labelTarget.id, labelIds: labelTarget.labelIds }]}
          onClose={closeLabel}
          onToggle={toggleLabel}
        />
      )}

      {composerDraft && (
        <Composer draft={composerDraft} onClose={() => setComposerDraft(null)} onToast={showToast} />
      )}

      <Toast toast={toast} />

      <MailFooter
        readerOpen={readerOpen}
        sync={sync}
        networkOnline={networkOnline}
        onRetry={retrySync}
        onCopyError={copySyncError}
      />
    </div>
  )
}
