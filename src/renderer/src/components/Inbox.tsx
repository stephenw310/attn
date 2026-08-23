import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AuthStatus, isSignInCanceled } from '../../../shared/auth'
import { type Draft, type DraftKind, emptyDraftInput } from '../../../shared/drafts'
import type { MailLabel } from '../../../shared/mail'
import { actionReconnectMessage } from '../actionReconnect'
import { Composer, type ComposerHandle } from '../composer/Composer'
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
import { OutboxList } from './OutboxList'
import { SnoozePicker } from './SnoozePicker'
import { ThreadList } from './ThreadList'
import { Toast } from './Toast'

interface InboxProps {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}

type MailView = 'inbox' | 'snoozed' | 'drafts' | 'outbox'

export function Inbox({ status, onStatus }: InboxProps): React.JSX.Element {
  const [view, setView] = useState<MailView>('inbox')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [labelTargetIds, setLabelTargetIds] = useState<readonly string[] | null>(null)
  const [composerDraft, setComposerDraft] = useState<Draft | null>(null)
  const [detachedDraftThread, setDetachedDraftThread] = useState<DisplayThread | null>(null)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectedDraftIdRef = useRef<string | null>(null)
  const activeViewRef = useRef<MailView>('inbox')
  const outboxReturnRef = useRef<{
    view: Exclude<MailView, 'outbox'>
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
  const activeComposerDraftIdRef = useRef<string | null>(null)
  const inlineComposerRef = useRef<ComposerHandle | null>(null)

  const activeAccount = status.email ?? null
  const {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    setRealSnoozedThreads,
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realUnreadTotal,
    labels,
    pendingActionCount,
    pausedActionCount,
    mailRevision,
    invalidateConversations,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  } = useMailData(activeAccount, activeViewRef, selectedThreadIdRef, selectedDraftIdRef, setSelectedIndex)
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])
  const online = networkOnline && sync.phase !== 'offline'
  const backingMailView = view === 'outbox' ? outboxReturnRef.current.view : view
  const threads: DisplayThread[] = useMemo(
    () =>
      backingMailView === 'inbox'
        ? (realThreads ?? []).map(displayThread)
        : backingMailView === 'snoozed'
          ? (realSnoozedThreads ?? []).map(displaySnoozedThread)
          : [],
    [backingMailView, realSnoozedThreads, realThreads]
  )
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
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetIds(null)
    setComposerDraft(null)
    setDetachedDraftThread(null)
    setComposerError(null)
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
    activeComposerDraftIdRef.current = composerDraft?.id ?? null
  }, [composerDraft?.id])

  useEffect(() => {
    const visibleCount =
      view === 'drafts' ? realDrafts.length : view === 'outbox' ? realOutbox.length : threads.length
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(visibleCount - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    if (view !== 'drafts' && threads.length === 0) setReaderOpen(false)
  }, [realDrafts.length, realOutbox.length, threads, view])

  const selected = detachedDraftThread ?? threads[selectedIndex]
  const conversationThreads = detachedDraftThread ? [detachedDraftThread] : threads
  const conversationSelectedIndex = detachedDraftThread ? 0 : selectedIndex
  const inlineComposerDraft =
    composerDraft && composerDraft.kind !== 'new' && readerOpen && selected?.id === composerDraft.threadId
      ? composerDraft
      : null
  const fullWindowComposerDraft = composerDraft && !inlineComposerDraft ? composerDraft : null

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
    mailRevision
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
    if (view === 'inbox' || view === 'snoozed') selectedThreadIdRef.current = selected?.id ?? null
  }, [selected?.id, view])

  useEffect(() => {
    selectedDraftIdRef.current =
      view === 'drafts'
        ? (realDrafts[selectedIndex]?.id ?? null)
        : view === 'outbox'
          ? (realOutbox[selectedIndex]?.id ?? null)
          : null
  }, [realDrafts, realOutbox, selectedIndex, view])

  const { retrySync, copySyncError } = useSyncActions(sync, showToast)

  useEffect(() => {
    if (!window.attn || !activeAccount) return
    return window.attn.mail.onActionsReverted(activeAccount, showToast)
  }, [activeAccount, showToast])

  const reconnectActions = useCallback(() => {
    if (!window.attn) return
    void window.attn.auth
      .signIn()
      .then((result) => {
        onStatus(result.status)
        void showToast(actionReconnectMessage(activeAccount ?? '', result))
      })
      .catch((reason: unknown) => {
        // A canceled or superseded sign-in is not a failure worth a toast.
        if (isSignInCanceled(reason)) return
        void showToast(reason instanceof Error ? reason.message : 'Could not reconnect Google')
      })
  }, [activeAccount, onStatus, showToast])

  const switchViewNow = useCallback((next: 'inbox' | 'snoozed' | 'drafts') => {
    activeViewRef.current = next
    selectedThreadIdRef.current = null
    selectedDraftIdRef.current = null
    setView(next)
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetIds(null)
    setDetachedDraftThread(null)
  }, [])

  const switchView = useCallback(
    (next: 'inbox' | 'snoozed' | 'drafts', afterSwitch?: () => void) => {
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

  const openOutboxNow = useCallback(() => {
    if (view === 'outbox') return
    outboxReturnRef.current = { view, selectedIndex, readerOpen }
    activeViewRef.current = 'outbox'
    selectedDraftIdRef.current = null
    setView('outbox')
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetIds(null)
  }, [readerOpen, selectedIndex, view])

  const openOutbox = useCallback(() => {
    if (view === 'outbox') return
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
    if (!window.attn || !activeAccount) return
    return window.attn.mail.onFocusThread((threadId) => {
      // Close the old reader before changing lists so auto-read cannot observe
      // an old cursor against Inbox and mutate the wrong thread.
      switchView('inbox', () => {
        clearSelection()
        void window.attn?.mail
          .listThreads()
          .then((nextThreads) => {
            const nextIndex = nextThreads.findIndex((thread) => thread.id === threadId)
            setRealThreads(nextThreads)
            if (nextIndex < 0) return
            selectedThreadIdRef.current = threadId
            setDetachedDraftThread(null)
            setSelectedIndex(nextIndex)
            setReaderOpen(true)
          })
          .catch(() => {})
      })
    })
  }, [activeAccount, clearSelection, setRealThreads, switchView])

  const triage = useTriage({
    selectedIds,
    selectedIndex,
    threads,
    readerOpen,
    view: view === 'snoozed' ? 'snoozed' : 'inbox',
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    selectedThreadIdRef,
    selectedRowRef,
    setRealThreads,
    setRealSnoozedThreads,
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
    if (view === 'outbox') {
      openOutboxItem(selectedIndex)
      return
    }
    if (view === 'drafts') {
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
    selectedThreadIdRef.current = thread.id
    setReaderOpen(true)
    reopenDraftForThread(thread.id)
  }, [openOutboxItem, realDrafts, reopenDraftForThread, selectedIndex, showDraft, threads, view])
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
  const closeSnooze = useCallback(() => setSnoozeOpen(false), [])
  const closeLabel = useCallback(() => setLabelTargetIds(null), [])
  const openSnooze = useCallback(() => {
    if (selected) setSnoozeOpen(true)
  }, [selected])
  const openLabel = useCallback(() => {
    if (!selected) return
    setLabelTargetIds(selectedIds.size > 0 ? [...selectedIds] : [selected.id])
  }, [selected, selectedIds])
  const openThread = useCallback(
    (index: number) => {
      const thread = threads[index]
      if (!thread) return
      // Opening unread mail can immediately broadcast a mark-read refresh. Pin
      // the identity before that refresh starts; the effect that mirrors index
      // changes is deliberately too late for this transition.
      selectedThreadIdRef.current = thread.id
      setDetachedDraftThread(null)
      setSelectedIndex(index)
      setReaderOpen(true)
      reopenDraftForThread(thread.id)
    },
    [reopenDraftForThread, threads]
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
      if (!window.attn || !selected || view === 'drafts' || composerOpeningRef.current) return
      if (!readerOpen) {
        selectedThreadIdRef.current = selected.id
        setDetachedDraftThread(null)
        setReaderOpen(true)
        setSnoozeOpen(false)
        setLabelTargetIds(null)
      }
      composerOpeningRef.current = true
      void window.attn.draft
        .createReply(selected.id, kind)
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
    [readerOpen, selected, showDraft, view]
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

  const visibleRowCount =
    view === 'drafts' ? realDrafts.length : view === 'outbox' ? realOutbox.length : threads.length

  // While reading, J/K opens the next/previous conversation at its newest
  // message or restored draft (SPEC §5) — the same entry point Enter and a row
  // click use, so a Draft chip behaves identically however the row is reached.
  const readNextThread = useCallback(
    (index: number) => {
      if (!readerOpen || view === 'drafts' || view === 'outbox') return
      const thread = threads[index]
      if (!thread) return
      selectedThreadIdRef.current = thread.id
      reopenDraftForThread(thread.id)
    },
    [readerOpen, reopenDraftForThread, threads, view]
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

  useInboxCommands({
    selected,
    selectedCount: selectedIds.size,
    selectedIndex,
    readerOpen,
    view,
    starOn,
    markUnreadOn,
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
    triage,
    openSnooze,
    openLabel,
    openComposer,
    openReply,
    showToast,
    reopenUndoDraft
  })

  useKeyboardDispatch({
    blocked: labelTargets !== undefined || composerDraft !== null,
    readerOpen,
    outboxOpen: view === 'outbox',
    snoozeOpen,
    onCloseSnooze: closeSnooze,
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
        view={view}
        unreadCount={realUnreadTotal}
        pendingActionCount={pendingActionCount}
        pausedActionCount={pausedActionCount}
        outboxCount={realOutbox.length}
        selectionCount={view === 'inbox' || view === 'snoozed' ? selectedIds.size : 0}
        composerOpen={fullWindowComposerDraft !== null}
        status={status}
        onStatus={onStatus}
        onReconnectActions={reconnectActions}
        onSwitchView={switchView}
        onOpenOutbox={openOutbox}
      />

      <div
        className={`min-h-0 flex-1 ${fullWindowComposerDraft ? 'hidden' : 'flex'}`}
        aria-hidden={!!fullWindowComposerDraft}
      >
        {view === 'drafts' ? (
          <DraftList
            drafts={realDrafts}
            readerOpen={readerOpen}
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
                  if (reopened) showDraft(reopened)
                })
                .catch(() => {})
            }}
          />
        ) : view === 'outbox' ? (
          <OutboxList
            items={realOutbox}
            selectedIndex={selectedIndex}
            selectedRowRef={selectedRowRef}
            onBack={closeOutbox}
            onOpen={(index) => {
              setSelectedIndex(index)
              selectedDraftIdRef.current = realOutbox[index]?.id ?? null
              openOutboxItem(index)
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
            selectedIndex={conversationSelectedIndex}
            threadCount={detachedDraftThread ? 1 : threads.length}
            view={view}
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

      {!fullWindowComposerDraft && (
        <MailFooter
          readerOpen={readerOpen}
          outboxOpen={view === 'outbox'}
          composing={inlineComposerDraft !== null}
          sync={sync}
          networkOnline={networkOnline}
          onRetry={retrySync}
          onCopyError={copySyncError}
        />
      )}
    </div>
  )
}
