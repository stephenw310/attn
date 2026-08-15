import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import { type Draft, type DraftKind, emptyDraftInput } from '../../../shared/drafts'
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
import { DraftList } from './DraftList'
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
  const [view, setView] = useState<'inbox' | 'snoozed' | 'drafts'>('inbox')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null)
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null)
  const [toast, showToast] = useToast()
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectedDraftIdRef = useRef<string | null>(null)
  const activeViewRef = useRef<'inbox' | 'snoozed' | 'drafts'>('inbox')
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
    realDrafts,
    refreshDrafts,
    realUnreadTotal,
    labels,
    pendingCount,
    mailRevision,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  } = useMailData(activeAccount, activeViewRef, selectedThreadIdRef, selectedDraftIdRef, setSelectedIndex)
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const online = networkOnline && sync.phase !== 'offline'
  const threads: DisplayThread[] = useMemo(
    () =>
      view === 'inbox'
        ? (realThreads ?? []).map(displayThread)
        : view === 'snoozed'
          ? (realSnoozedThreads ?? []).map(displaySnoozedThread)
          : [],
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
    selectedDraftIdRef.current = null
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
    const visibleCount = view === 'drafts' ? realDrafts.length : threads.length
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(visibleCount - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    if (view !== 'drafts' && threads.length === 0) setReaderOpen(false)
  }, [realDrafts.length, threads, view])

  const selected = threads[selectedIndex]
  const { conversation, scrollRef: conversationScrollRef } = useConversation({
    selected,
    selectedIndex,
    threads,
    readerOpen,
    online,
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

  useEffect(() => {
    selectedDraftIdRef.current = view === 'drafts' ? (realDrafts[selectedIndex]?.id ?? null) : null
  }, [realDrafts, selectedIndex, view])

  const { retrySync, copySyncError } = useSyncActions(sync, showToast)

  const switchView = useCallback((next: 'inbox' | 'snoozed' | 'drafts') => {
    activeViewRef.current = next
    selectedThreadIdRef.current = null
    selectedDraftIdRef.current = null
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
    view: view === 'snoozed' ? 'snoozed' : 'inbox',
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
    if (view === 'drafts') {
      const draft = realDrafts[selectedIndex]
      if (!draft || !window.attn) return
      void window.attn.draft
        .reopen(draft.id)
        .then((reopened) => {
          if (reopened) setComposerDraft(reopened)
        })
        .catch(() => {})
      return
    }
    const thread = threads[selectedIndex]
    if (!thread) return
    selectedThreadIdRef.current = thread.id
    setReaderOpen(true)
  }, [realDrafts, selectedIndex, threads, view])
  const closeReader = useCallback(() => setReaderOpen(false), [])
  const closeSnooze = useCallback(() => setSnoozeOpen(false), [])
  const closeLabel = useCallback(() => setLabelTargetId(null), [])
  const openSnooze = useCallback(() => {
    if (selected) setSnoozeOpen(true)
  }, [selected])
  const openLabel = useCallback(() => {
    if (selected) setLabelTargetId(selected.id)
  }, [selected])
  const openThread = useCallback(
    (index: number) => {
      const thread = threads[index]
      if (!thread) return
      // Opening unread mail can immediately broadcast a mark-read refresh. Pin
      // the identity before that refresh starts; the effect that mirrors index
      // changes is deliberately too late for this transition.
      selectedThreadIdRef.current = thread.id
      setSelectedIndex(index)
      setReaderOpen(true)
    },
    [threads]
  )
  const openComposer = useCallback(() => {
    if (!window.attn || composerOpeningRef.current) return
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
  }, [])

  const openReply = useCallback(
    (kind: Exclude<DraftKind, 'new'>) => {
      if (!window.attn || !readerOpen || !selected || composerOpeningRef.current) return
      composerOpeningRef.current = true
      void window.attn.draft
        .createReply(selected.id, kind)
        .then((draft) => {
          if (draft) setComposerDraft(draft)
        })
        .catch(() => {})
        .finally(() => {
          composerOpeningRef.current = false
        })
    },
    [readerOpen, selected]
  )

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
    threadCount: view === 'drafts' ? realDrafts.length : threads.length,
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
    openReply,
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
        selectionCount={view === 'drafts' ? 0 : selectedIds.size}
        composerOpen={composerDraft !== null}
        status={status}
        onStatus={onStatus}
        onSwitchView={switchView}
      />

      <div className={`min-h-0 flex-1 ${composerDraft ? 'hidden' : 'flex'}`} aria-hidden={!!composerDraft}>
        {view === 'drafts' ? (
          <DraftList
            drafts={realDrafts}
            selectedIndex={selectedIndex}
            selectedRowRef={selectedRowRef}
            onOpen={(index) => {
              setSelectedIndex(index)
              const draft = realDrafts[index]
              if (!draft || !window.attn) return
              selectedDraftIdRef.current = draft.id
              void window.attn.draft
                .reopen(draft.id)
                .then((reopened) => {
                  if (reopened) setComposerDraft(reopened)
                })
                .catch(() => {})
            }}
          />
        ) : (
          <ThreadList
            threads={threads}
            view={view === 'snoozed' ? 'snoozed' : 'inbox'}
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
        )}

        {readerOpen && selected && (
          <ConversationView
            selected={selected}
            selectedIndex={selectedIndex}
            threadCount={threads.length}
            view={view === 'snoozed' ? 'snoozed' : 'inbox'}
            conversation={conversation}
            account={activeAccount}
            online={online}
            scrollRef={conversationScrollRef}
            onClose={closeReader}
            onToast={showToast}
          />
        )}
      </div>

      {!composerDraft && snoozeOpen && selected && (
        <SnoozePicker
          targetCount={targetedThreads.length}
          onCancel={closeSnooze}
          onConfirm={snoozeSelected}
          onUnsnooze={view === 'snoozed' ? unsnoozeSelected : undefined}
        />
      )}

      {!composerDraft && labelTarget && (
        <LabelPicker
          labels={labels}
          targets={[{ id: labelTarget.id, labelIds: labelTarget.labelIds }]}
          onClose={closeLabel}
          onToggle={toggleLabel}
        />
      )}

      {composerDraft && (
        <Composer
          draft={composerDraft}
          onClose={() => {
            setComposerDraft(null)
            void refreshDrafts().catch(() => {})
          }}
          onToast={showToast}
        />
      )}

      <Toast toast={toast} />

      {!composerDraft && (
        <MailFooter
          readerOpen={readerOpen}
          sync={sync}
          networkOnline={networkOnline}
          onRetry={retrySync}
          onCopyError={copySyncError}
        />
      )}
    </div>
  )
}
