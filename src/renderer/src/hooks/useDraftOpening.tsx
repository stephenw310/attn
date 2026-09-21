import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Draft, type DraftKind, emptyDraftInput } from '../../../shared/drafts'
import { plainTextToDraftHtml } from '../../../shared/html'
import type { SnoozedThreadRow, ThreadRow } from '../../../shared/mail'
import type { MailtoPrefill } from '../../../shared/mailto'
import type { OutboxItem } from '../../../shared/outbox'
import { aiThreadContext } from '../aiContext'
import type { MessageReplyTarget } from '../components/ConversationView'
import { Composer, type ComposerHandle } from '../composer/Composer'
import {
  type DisplayConversation,
  type DisplayThread,
  displaySnoozedThread,
  displayThread,
  type MailView
} from '../list/mailDisplay'
import { conversationMailboxFor, conversationMailboxForSearch } from '../searchView'
import type { ShowToast } from './useToast'

interface Options {
  account: string | null
  view: MailView
  viewRef: React.RefObject<MailView>
  searchOpen: boolean
  searchOpenRef: React.RefObject<boolean>
  /** The query the visible search results answer — it picks the reply mailbox. */
  searchResultQuery: string
  readerOpen: boolean
  readerOpenRef: React.RefObject<boolean>
  /** The focused conversation, read when a command runs rather than captured. */
  selectedRef: React.RefObject<DisplayThread | undefined>
  selected: DisplayThread | undefined
  conversation: DisplayConversation | null
  /** The reader's message cursor: a reply targets exactly what is being read. */
  messageReplyTargetRef: React.RefObject<MessageReplyTarget | null>
  composerDraft: Draft | null
  setComposerDraft: (draft: Draft | null) => void
  composerError: string | null
  setComposerError: (message: string | null) => void
  setDetachedDraftThread: (thread: DisplayThread | null) => void
  realThreads: readonly ThreadRow[] | null
  realSnoozedThreads: readonly SnoozedThreadRow[] | null
  realDrafts: readonly Draft[]
  realOutbox: readonly OutboxItem[]
  selectedIndex: number
  /** A settling account switch makes every draft open inert (F18). */
  accountSwitchPendingRef: React.RefObject<boolean>
  /** Set while a create round trip is in flight, so a second open is refused. */
  composerOpeningRef: React.RefObject<boolean>
  /** Bumped by a reader close; a superseded reopen releases its lease. */
  draftOpenRequestRef: React.RefObject<number>
  draftOpenTargetRef: React.RefObject<{ request: number; draftId: string; threadId: string } | null>
  inlineComposerRef: React.RefObject<ComposerHandle | null>
  selectedThreadIdRef: React.RefObject<string | null>
  selectedDraftIdRef: React.RefObject<string | null>
  settingsOpenRef: React.RefObject<boolean>
  applyView: (view: MailView) => void
  clearSelection: () => void
  setSelectedIndex: (index: number) => void
  setReaderOpen: (open: boolean) => void
  /** The snooze and label pickers, which belong to the row left behind. */
  closePickers: () => void
  finishReaderClose: () => void
  invalidateConversations: () => void
  refreshMailRows: () => Promise<void>
  refreshDrafts: () => Promise<void>
  showToast: ShowToast
}

export interface DraftOpening {
  /** Show a draft, navigating to its conversation when one is listed. */
  showDraft: (draft: Draft) => void
  /** Reopen the drafted reply parked on a thread as the reader opens it. */
  reopenDraftForThread: (threadId: string) => void
  /** Shared by the Drafts list and draft search results. */
  reopenListDraft: (draftId: string) => void
  /** Undo-send handed back a draft id; reopen it without a list row. */
  reopenUndoDraft: (id: string) => void
  openOutboxItem: (index: number) => void
  /** New mail, optionally prefilled from a `mailto:` link; true when it opened. */
  openComposer: (prefill?: MailtoPrefill) => Promise<boolean>
  openReply: (kind: Exclude<DraftKind, 'new'>, sourceMessageId?: string) => void
  /** Enter expands the reader's focused message, or replies to all (F3). */
  openMessageOrReplyAll: () => void
  closeComposer: () => void
  discardSelectedDraft: () => void
  /** The palette's `Draft with AI` (T37, F17), from the reader or a reply. */
  requestAiDraftCommand: () => void
  /** The reply composer mounted inside the conversation, if any. */
  inlineComposerDraft: Draft | null
  inlineComposer: React.JSX.Element | null
  /** A draft that covers the whole window instead (new mail, or a list draft). */
  fullWindowComposerDraft: Draft | null
}

/**
 * Every route into a composer: the Drafts list, a reader's parked reply, an
 * outbox item, undo-send, the AI command, and plain Compose. The draft pointer
 * is a lease — `draft:reopen` mutates the row before returning it — so each
 * route gates on a settling account switch before it asks, and a superseded
 * reopen releases the row it was handed unless a newer owner already has it.
 */
export function useDraftOpening(options: Options): DraftOpening {
  const latest = useRef(options)
  latest.current = options
  const { account, composerDraft, composerError, conversation, readerOpen, selected, showToast } = options
  const activeComposerDraftIdRef = useRef<string | null>(null)
  const discardingDraftIdRef = useRef<string | null>(null)

  const showDraft = useCallback((draft: Draft) => {
    const options = latest.current
    const { selectedThreadIdRef, selectedDraftIdRef } = options
    if (options.accountSwitchPendingRef.current) return
    activeComposerDraftIdRef.current = draft.id
    if (draft.kind !== 'new' && draft.threadId) {
      const inboxIndex = (options.realThreads ?? []).findIndex((thread) => thread.id === draft.threadId)
      const snoozedIndex = (options.realSnoozedThreads ?? []).findIndex(
        (thread) => thread.id === draft.threadId
      )
      const cachedThread =
        inboxIndex >= 0
          ? displayThread((options.realThreads ?? [])[inboxIndex])
          : snoozedIndex >= 0
            ? displaySnoozedThread((options.realSnoozedThreads ?? [])[snoozedIndex])
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
        followUpReturned: false,
        hasDraft: true,
        labelIds: [],
        lastMsgAt: draft.updatedAt
      }

      if (options.viewRef.current === 'drafts') {
        // Keep Drafts as the navigation origin even when the parent thread is
        // also cached in Inbox or Snoozed. The reader can render that cached
        // thread as a detached item without changing the underlying list.
        selectedThreadIdRef.current = draft.threadId
        options.setReaderOpen(true)
        options.closePickers()
        options.setDetachedDraftThread(cachedThread ?? fallbackThread)
        options.setComposerDraft(draft)
        return
      }
      const destination =
        inboxIndex >= 0
          ? { view: 'inbox' as const, index: inboxIndex }
          : snoozedIndex >= 0
            ? { view: 'snoozed' as const, index: snoozedIndex }
            : null
      if (destination) {
        selectedThreadIdRef.current = draft.threadId
        selectedDraftIdRef.current = null
        options.clearSelection()
        options.applyView(destination.view)
        options.setSelectedIndex(destination.index)
        options.setReaderOpen(true)
        options.closePickers()
        options.setDetachedDraftThread(null)
      } else {
        options.setDetachedDraftThread(fallbackThread)
        selectedThreadIdRef.current = draft.threadId
        options.setReaderOpen(true)
      }
    }
    options.setComposerDraft(draft)
  }, [])

  useEffect(() => {
    activeComposerDraftIdRef.current = composerDraft?.id ?? null
  }, [composerDraft?.id])

  useEffect(() => {
    // Taking consumes the recovered pointer; skip while a switch is settling
    // so an unclaimed crash recovery stays claimable instead of vanishing.
    const options = latest.current
    if (!window.attn || !account || options.accountSwitchPendingRef.current) return
    let active = true
    void window.attn.draft
      .takeRecovered()
      .then((draft) => {
        if (active && draft && !latest.current.accountSwitchPendingRef.current) {
          latest.current.setComposerDraft(draft)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [account])

  const reopenDraftForThread = useCallback((threadId: string) => {
    const options = latest.current
    const { draftOpenRequestRef, draftOpenTargetRef, selectedThreadIdRef } = options
    const draft = options.realDrafts.find(
      (candidate) => candidate.kind !== 'new' && candidate.threadId === threadId
    )
    if (!draft || !window.attn) return
    // Reopening mutates the draft pointer; while a switch is settling
    // nothing may touch the outgoing account's queue (F18), so the gate
    // sits before the request, not on its completion.
    if (options.accountSwitchPendingRef.current) return
    const request = ++draftOpenRequestRef.current
    draftOpenTargetRef.current = { request, draftId: draft.id, threadId }
    void window.attn.draft
      .reopen(draft.id)
      .then((reopened) => {
        if (!reopened) {
          if (draftOpenTargetRef.current?.request === request) draftOpenTargetRef.current = null
          return
        }
        const ownsResult =
          request === draftOpenRequestRef.current &&
          selectedThreadIdRef.current === threadId &&
          !latest.current.accountSwitchPendingRef.current
        if (ownsResult) {
          draftOpenTargetRef.current = null
          activeComposerDraftIdRef.current = reopened.id
          latest.current.setComposerDraft(reopened)
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
  }, [])

  const openOutboxItem = useCallback((index: number) => {
    const options = latest.current
    const item = options.realOutbox[index]
    if (!item || !window.attn) return
    // undoSend cancels the scheduled send and reopen mutates the row, so the
    // switch-settling gate must run before either request goes out — a
    // gated completion alone would cancel a send and then hide its composer.
    if (options.accountSwitchPendingRef.current) return
    if (item.state === 'sending') {
      options.showToast('Sending in progress')
      return
    }
    const request =
      item.state === 'queued' ? window.attn.outbox.undoSend(item.id) : window.attn.outbox.reopen(item.id)
    void request
      .then((result) => {
        if (!result.draft) {
          if (result.error) latest.current.showToast(result.error)
          return
        }
        if (latest.current.accountSwitchPendingRef.current) return
        latest.current.setComposerError(result.error)
        latest.current.setComposerDraft(result.draft)
      })
      .catch(() => latest.current.showToast('Message could not be reopened'))
  }, [])

  const reopenUndoDraft = useCallback((id: string) => {
    if (!window.attn || latest.current.accountSwitchPendingRef.current) return
    void window.attn.draft
      .get(id)
      .then((draft) => {
        if (!draft || latest.current.accountSwitchPendingRef.current) return
        latest.current.setComposerError(null)
        latest.current.setComposerDraft(draft)
      })
      .catch(() => {})
  }, [])

  const reopenListDraft = useCallback(
    (draftId: string) => {
      if (!window.attn || latest.current.accountSwitchPendingRef.current) return
      void window.attn.draft
        .reopen(draftId)
        .then((reopened) => {
          if (reopened) showDraft(reopened)
        })
        .catch(() => {})
    },
    [showDraft]
  )

  /**
   * Plain Compose, and the `mailto:` link that carries fields with it (F16).
   * The answer says whether the composer actually opened, so a deep link can
   * stay pending in the main process when a settling account switch or an
   * in-flight open refused it.
   *
   * `prefill` is a parsed link, never an event: every DOM handler must call
   * this through a wrapper, because `() => void` silently accepts a direct
   * `onClick={openComposer}` and would hand a MouseEvent to the draft.
   */
  const openComposer = useCallback((prefill?: MailtoPrefill): Promise<boolean> => {
    const options = latest.current
    const bridge = window.attn
    if (!bridge || options.composerOpeningRef.current || options.accountSwitchPendingRef.current) {
      return Promise.resolve(false)
    }
    options.composerOpeningRef.current = true
    // A link with no body leaves the body empty on purpose: the account's
    // signature and footer are inserted only into an empty draft (F6).
    const input = prefill
      ? {
          ...emptyDraftInput(),
          to: prefill.to,
          cc: prefill.cc,
          bcc: prefill.bcc,
          subject: prefill.subject,
          bodyText: prefill.bodyText,
          bodyHtml: plainTextToDraftHtml(prefill.bodyText)
        }
      : emptyDraftInput()
    return bridge.draft
      .save(input)
      .then(({ draft }) => {
        if (!draft || latest.current.accountSwitchPendingRef.current) return false
        latest.current.setComposerError(null)
        latest.current.setComposerDraft(draft)
        return true
      })
      .catch(() => false)
      .finally(() => {
        latest.current.composerOpeningRef.current = false
      })
  }, [])

  // A pending AI invocation must not outlive the composer (or the failed
  // open) it targeted: reopening a reply later must start clean.
  const [aiDraftRequest, setAiDraftRequest] = useState(0)
  const aiDraftPendingRef = useRef<string | null>(null)
  const aiCommandPreparingRef = useRef(false)
  useEffect(() => {
    if (composerDraft === null) aiDraftPendingRef.current = null
  }, [composerDraft])
  const claimAiDraftRequest = useCallback((threadId: string) => {
    if (aiDraftPendingRef.current === null || aiDraftPendingRef.current !== threadId) return false
    aiDraftPendingRef.current = null
    return true
  }, [])
  const requestAiDraft = useCallback((threadId: string) => {
    aiDraftPendingRef.current = threadId
    setAiDraftRequest((count) => count + 1)
  }, [])

  const openReply = useCallback(
    (kind: Exclude<DraftKind, 'new'>, sourceMessageId?: string) => {
      const options = latest.current
      const selected = options.selectedRef.current
      const readerOpen = options.readerOpenRef.current
      const searchOpen = options.searchOpenRef.current
      const view = options.viewRef.current
      if (
        !window.attn ||
        !selected ||
        (!readerOpen && !searchOpen && view === 'drafts') ||
        options.composerOpeningRef.current ||
        options.draftOpenTargetRef.current?.threadId === selected.id ||
        options.accountSwitchPendingRef.current
      )
        return
      // Keep reply shortcuts available during the initial conversation read.
      // Once the reader has a cursor, use that exact message instead of the
      // thread default. The thread id prevents a previous reader's target from
      // leaking into a fast conversation switch.
      const target = readerOpen ? options.messageReplyTargetRef.current : null
      const useReaderTarget = sourceMessageId === undefined && target?.threadId === selected.id
      if (useReaderTarget && !target.canReply) {
        options.showToast('This message is not available for a reply or forward')
        return
      }
      const replySourceMessageId = useReaderTarget ? target.messageId : sourceMessageId
      if (!readerOpen) {
        options.selectedThreadIdRef.current = selected.id
        options.setDetachedDraftThread(null)
        options.setReaderOpen(true)
        options.closePickers()
      }
      options.composerOpeningRef.current = true
      const replyMailbox = searchOpen
        ? conversationMailboxForSearch(options.searchResultQuery)
        : conversationMailboxFor(view)
      void window.attn.draft
        .createReply(selected.id, kind, replyMailbox, replySourceMessageId)
        .then((draft) => {
          if (draft) {
            latest.current.setComposerError(null)
            showDraft(draft)
          } else {
            // The reply never opened, so a parked AI invocation targeting it
            // must not wait around for an unrelated later composer.
            aiDraftPendingRef.current = null
            latest.current.showToast(
              'Could not open this message for a reply or forward. Its body may not be available offline.'
            )
          }
        })
        .catch(() => {
          aiDraftPendingRef.current = null
          latest.current.showToast('Could not open the reply or forward draft')
        })
        .finally(() => {
          latest.current.composerOpeningRef.current = false
        })
    },
    [showDraft]
  )

  const openMessageOrReplyAll = useCallback(() => {
    const options = latest.current
    const selected = options.selectedRef.current
    if (!options.readerOpenRef.current || !selected) return
    const target = options.messageReplyTargetRef.current
    if (target?.threadId === selected.id && target.expand) {
      target.expand()
      return
    }
    openReply('replyAll')
  }, [openReply])

  const closeComposer = useCallback(() => {
    const options = latest.current
    activeComposerDraftIdRef.current = null
    // Closing is the local handoff from an inline composer back to its
    // conversation. Invalidate directly instead of relying on the outbox event
    // racing the IPC response, so a queued reply/forward is fetched in the same
    // render turn that removes the composer.
    options.invalidateConversations()
    options.setComposerDraft(null)
    void options.refreshMailRows().catch(() => {
      void latest.current.refreshDrafts().catch(() => {})
    })
  }, [])

  const closeComposerAndReader = useCallback(() => {
    closeComposer()
    latest.current.finishReaderClose()
  }, [closeComposer])

  const discardSelectedDraft = useCallback(() => {
    const options = latest.current
    if (
      options.searchOpenRef.current ||
      options.viewRef.current !== 'drafts' ||
      !window.attn ||
      discardingDraftIdRef.current
    ) {
      return
    }
    const draft = options.realDrafts[options.selectedIndex]
    if (!draft) return
    discardingDraftIdRef.current = draft.id
    void window.attn.draft
      .discard(draft.id, 'drafted')
      .then(() => {
        latest.current.showToast('Draft discarded')
        void latest.current.refreshMailRows().catch(() => {
          void latest.current.refreshDrafts().catch(() => {})
        })
      })
      .catch(() => latest.current.showToast('Draft could not be discarded'))
      .finally(() => {
        discardingDraftIdRef.current = null
      })
  }, [])

  const inlineComposerDraft =
    composerDraft && composerDraft.kind !== 'new' && readerOpen && selected?.id === composerDraft.threadId
      ? composerDraft
      : null
  const fullWindowComposerDraft = composerDraft && !inlineComposerDraft ? composerDraft : null
  // Render-time mirror for the Draft-AI-reply command: only the inline reply
  // composer mounts the plugin that can serve an invocation.
  const inlineComposerDraftIdRef = useRef<string | null>(null)
  inlineComposerDraftIdRef.current = inlineComposerDraft?.id ?? null
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  const getAiThreadContext = useCallback(
    (sourceMessageId: string | null) => aiThreadContext(conversationRef.current, sourceMessageId),
    []
  )

  // T37 (F17): from the reader the command opens the inline reply first, then
  // streams into it; in a reply composer it streams in place. New messages and
  // forwards are out of v1's whole-body generation scope.
  const requestAiDraftCommand = useCallback(() => {
    const bridge = window.attn?.ai
    if (!bridge) return
    const options = latest.current
    const open = options.composerDraft
    if (open) {
      // The mounted plugin owns settings and style preparation. Claim
      // synchronously here so a second shortcut cannot queue another
      // invocation whose async preparation outlives Esc on the first.
      if (aiDraftPendingRef.current !== null) return
      if (open.kind !== 'reply' && open.kind !== 'replyAll') {
        options.showToast('AI drafting writes replies — reply to a conversation to use it')
      } else if (open.id === inlineComposerDraftIdRef.current && open.threadId) {
        requestAiDraft(open.threadId)
      } else {
        options.showToast('Open the reply from its conversation to draft with AI')
      }
      return
    }
    if (aiCommandPreparingRef.current || aiDraftPendingRef.current !== null) return
    // Coalesce repeated shortcuts before either the existing composer or
    // reader-opened composer can claim the request.
    aiCommandPreparingRef.current = true
    // The target is what the user is looking at NOW: the settings round trip
    // yields, and the selection or open composer can change underneath it — a
    // stale invocation must do nothing rather than draft for the newly opened
    // conversation (PR #101 review).
    const target = options.readerOpenRef.current ? (options.selectedRef.current ?? null) : null
    const messageTarget = target ? options.messageReplyTargetRef.current : null
    const targetMessageId =
      target !== null && messageTarget?.threadId === target.id ? messageTarget.messageId : null
    void bridge
      .getSettings()
      .then((ai) => {
        const current = latest.current
        if (!ai.enabled) {
          current.showToast('Enable AI writing in Settings to draft replies')
          return
        }
        if (target) {
          if (!current.readerOpenRef.current || current.selectedRef.current?.id !== target.id) return
          if (
            current.settingsOpenRef.current ||
            current.composerDraft !== null ||
            current.composerOpeningRef.current
          ) {
            return
          }
          const currentMessageTarget = current.messageReplyTargetRef.current
          const currentMessageId =
            currentMessageTarget?.threadId === target.id ? currentMessageTarget.messageId : null
          // The reader shell can render just before ConversationView publishes
          // its initial latest-message cursor. That null → id transition is
          // initialization, not a user moving the cursor, so let the command
          // bind to the now-known source. Once a source existed at invocation
          // time, any change still cancels the stale request.
          if (targetMessageId !== null && currentMessageId !== targetMessageId) return
          const sourceMessageId = targetMessageId ?? currentMessageId
          requestAiDraft(target.id)
          openReply('reply', sourceMessageId ?? undefined)
          return
        }
        current.showToast('Open a conversation to draft an AI reply')
      })
      .catch(() => {})
      .finally(() => {
        aiCommandPreparingRef.current = false
      })
  }, [openReply, requestAiDraft])

  const inlineComposerAiDraft = useMemo(
    () =>
      inlineComposerDraft
        ? {
            request: aiDraftRequest,
            claim: () =>
              inlineComposerDraft.threadId !== null && claimAiDraftRequest(inlineComposerDraft.threadId),
            getThreadContext: () => getAiThreadContext(inlineComposerDraft.sourceMessageId)
          }
        : null,
    [aiDraftRequest, claimAiDraftRequest, getAiThreadContext, inlineComposerDraft]
  )
  // ThreadList and ConversationView are memoized, so every prop they take has
  // to keep its identity across renders they do not care about — a sync push
  // must not re-render a mounted Lexical tree (P3).
  const inlineComposer = useMemo(
    () =>
      inlineComposerDraft && account && inlineComposerAiDraft ? (
        <Composer
          key={inlineComposerDraft.id}
          ref={latest.current.inlineComposerRef}
          draft={inlineComposerDraft}
          mode="inline"
          initialError={composerError}
          onClose={closeComposer}
          onExit={closeComposerAndReader}
          onToast={showToast}
          aiDraft={inlineComposerAiDraft}
        />
      ) : null,
    [
      account,
      closeComposer,
      closeComposerAndReader,
      composerError,
      inlineComposerAiDraft,
      inlineComposerDraft,
      showToast
    ]
  )

  return {
    showDraft,
    reopenDraftForThread,
    reopenListDraft,
    reopenUndoDraft,
    openOutboxItem,
    openComposer,
    openReply,
    openMessageOrReplyAll,
    closeComposer,
    discardSelectedDraft,
    requestAiDraftCommand,
    inlineComposerDraft,
    inlineComposer,
    fullWindowComposerDraft
  }
}
