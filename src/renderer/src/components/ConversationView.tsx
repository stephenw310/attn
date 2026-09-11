import { memo, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DraftKind } from '../../../shared/drafts'
import type { MailLabel } from '../../../shared/mail'
import { bodyHydrationStatusMessage } from '../bodyHydrationStatus'
import { createCommand, registerCommands } from '../commands'
import { labelColor } from '../list/labelColor'
import type { DisplayConversation, DisplayThread } from '../list/mailDisplay'
import { Button } from './Button'
import { Kbd } from './Kbd'
import { MessageCard } from './MessageCard'

export interface MessageReplyTarget {
  threadId: string
  messageId: string
  canReply: boolean
  expand: (() => void) | null
}

interface ConversationMessagesProps {
  conversation: DisplayConversation
  labels: readonly MailLabel[]
  labelIds: readonly string[]
  onOpenLabel: (labelId: string) => void
  account: string | null
  online: boolean
  inlineComposer: ReactNode | null
  inlineComposerSourceMessageId: string | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  replyTargetRef: React.RefObject<MessageReplyTarget | null>
  onReply?: (kind: Exclude<DraftKind, 'new'>, messageId: string) => void
}

/** The newest message a reader expands: trashed markers stay compact (SPEC F3). */
function newestReadableIndex(messages: readonly DisplayConversation['messages'][number][]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!messages[index].trashed) return index
  }
  return messages.length - 1
}

function ConversationMessages(props: ConversationMessagesProps): React.JSX.Element {
  const {
    conversation,
    labels,
    labelIds,
    onOpenLabel,
    account,
    online,
    inlineComposer,
    inlineComposerSourceMessageId,
    scrollRef,
    replyTargetRef,
    onReply
  } = props
  const newestIndex = newestReadableIndex(conversation.messages)
  const newestMessageId = conversation.messages[newestIndex]?.id
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => {
    return new Set(newestMessageId ? [newestMessageId] : [])
  })
  const [expandedTrimIds, setExpandedTrimIds] = useState<Set<string>>(() => new Set())
  const [activeMessageId, setActiveMessageId] = useState<string | null>(newestMessageId ?? null)
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>())
  // Reveal state is reader-local by design (SPEC F3): it lives here so closing
  // the reader unmounts it, and revealing changes no labels and queues nothing.
  const [revealedTrashedIds, setRevealedTrashedIds] = useState<Set<string>>(() => new Set())

  // This component stays mounted while local outbox and sync updates append to
  // the same thread. Every newly newest message starts open, just like the
  // initial newest message, instead of inheriting the older collapsed default.
  useLayoutEffect(() => {
    if (!newestMessageId) return
    setExpandedMessageIds((current) => {
      if (current.has(newestMessageId)) return current
      const next = new Set(current)
      next.add(newestMessageId)
      return next
    })
  }, [newestMessageId])

  useLayoutEffect(() => {
    setActiveMessageId((current) => {
      if (conversation.messages.some((message) => message.id === inlineComposerSourceMessageId)) {
        return inlineComposerSourceMessageId
      }
      if (conversation.messages[newestIndex]?.pending) return newestMessageId ?? null
      return conversation.messages.some((message) => message.id === current)
        ? current
        : (newestMessageId ?? null)
    })
  }, [conversation.messages, inlineComposerSourceMessageId, newestIndex, newestMessageId])

  // Reopened drafts select and expand their saved source too. Keep the composer
  // in the same keyed sibling list while its source loads so edits never remount.
  useLayoutEffect(() => {
    if (!inlineComposerSourceMessageId) return
    setActiveMessageId(inlineComposerSourceMessageId)
    setExpandedMessageIds((current) => new Set(current).add(inlineComposerSourceMessageId))
    setRevealedTrashedIds((current) => new Set(current).add(inlineComposerSourceMessageId))
  }, [inlineComposerSourceMessageId])

  const toggleMessage = useCallback((messageId: string) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  const toggleTrim = useCallback((messageId: string) => {
    setExpandedTrimIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  const revealTrashed = useCallback((messageId: string) => {
    setRevealedTrashedIds((current) => {
      const next = new Set(current)
      next.add(messageId)
      return next
    })
    setExpandedMessageIds((current) => {
      const next = new Set(current)
      next.add(messageId)
      return next
    })
  }, [])

  const alignMessage = useCallback(
    (messageId: string) => {
      requestAnimationFrame(() => {
        const scroll = scrollRef.current
        const target = messageElementsRef.current.get(messageId)
        if (!scroll || !target) return
        const scrollRect = scroll.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const padding = 12
        if (targetRect.top < scrollRect.top + padding) {
          scroll.scrollTop += targetRect.top - scrollRect.top - padding
          return
        }
        const targetHeaderBottom = Math.min(targetRect.bottom, targetRect.top + 80)
        if (targetHeaderBottom > scrollRect.bottom - padding) {
          scroll.scrollTop += targetHeaderBottom - scrollRect.bottom + padding
        }
      })
    },
    [scrollRef]
  )

  const activateMessage = useCallback(
    (messageId: string) => {
      setActiveMessageId(messageId)
      alignMessage(messageId)
    },
    [alignMessage]
  )

  const moveMessage = useCallback(
    (offset: number) => {
      if (conversation.messages.length === 0) return
      const currentIndex = Math.max(
        0,
        conversation.messages.findIndex((message) => message.id === activeMessageId)
      )
      const nextIndex = Math.max(0, Math.min(conversation.messages.length - 1, currentIndex + offset))
      const nextMessage = conversation.messages[nextIndex]
      if (nextMessage) activateMessage(nextMessage.id)
    },
    [activateMessage, activeMessageId, conversation.messages]
  )

  const toggleActiveMessage = useCallback(() => {
    const activeMessage = conversation.messages.find((message) => message.id === activeMessageId)
    if (!activeMessage) return
    if (activeMessage.trashed && !revealedTrashedIds.has(activeMessage.id)) {
      revealTrashed(activeMessage.id)
    } else toggleMessage(activeMessage.id)
    alignMessage(activeMessage.id)
  }, [activeMessageId, alignMessage, conversation.messages, revealTrashed, revealedTrashedIds, toggleMessage])

  const replyToMessage = useCallback(
    (kind: Exclude<DraftKind, 'new'>, messageId: string) => {
      setActiveMessageId(messageId)
      setExpandedMessageIds((current) => new Set(current).add(messageId))
      onReply?.(kind, messageId)
    },
    [onReply]
  )

  useLayoutEffect(() => {
    if (!activeMessageId) return
    return registerCommands([
      createCommand('message.next', () => moveMessage(1)),
      createCommand('message.previous', () => moveMessage(-1)),
      createCommand('message.toggle', toggleActiveMessage),
      createCommand('message.trim.toggle', () => toggleTrim(activeMessageId))
    ])
  }, [activeMessageId, moveMessage, toggleActiveMessage, toggleTrim])

  useLayoutEffect(() => {
    const activeMessage = conversation.messages.find((message) => message.id === activeMessageId)
    const target = activeMessage
      ? {
          threadId: conversation.threadId,
          messageId: activeMessage.id,
          expand:
            !expandedMessageIds.has(activeMessage.id) ||
            (activeMessage.trashed && !revealedTrashedIds.has(activeMessage.id))
              ? toggleActiveMessage
              : null,
          canReply:
            !activeMessage.pending && (!activeMessage.trashed || revealedTrashedIds.has(activeMessage.id))
        }
      : null
    replyTargetRef.current = target
    return () => {
      if (replyTargetRef.current === target) replyTargetRef.current = null
    }
  }, [
    activeMessageId,
    conversation.messages,
    conversation.threadId,
    expandedMessageIds,
    replyTargetRef,
    revealedTrashedIds,
    toggleActiveMessage
  ])

  useLayoutEffect(() => {
    const activeMessage = conversation.messages.find((message) => message.id === activeMessageId)
    if (
      !onReply ||
      !activeMessage ||
      activeMessage.pending ||
      (activeMessage.trashed && !revealedTrashedIds.has(activeMessage.id))
    )
      return
    return registerCommands([
      createCommand('message.reply', () => replyToMessage('reply', activeMessage.id)),
      createCommand('message.replyAll', () => replyToMessage('replyAll', activeMessage.id)),
      createCommand('message.forward', () => replyToMessage('forward', activeMessage.id))
    ])
  }, [activeMessageId, conversation.messages, onReply, replyToMessage, revealedTrashedIds])

  const readableMessages = useMemo(
    () => conversation.messages.filter((message) => !message.trashed || revealedTrashedIds.has(message.id)),
    [conversation.messages, revealedTrashedIds]
  )
  const allExpanded =
    readableMessages.length > 0 && readableMessages.every((message) => expandedMessageIds.has(message.id))
  const toggleAll = useCallback(() => {
    setExpandedMessageIds(allExpanded ? new Set() : new Set(readableMessages.map((message) => message.id)))
  }, [allExpanded, readableMessages])
  useLayoutEffect(() => registerCommands([createCommand('message.toggleAll', toggleAll)]), [toggleAll])
  const participants = [...new Set(conversation.messages.map((message) => message.fromName))].join(', ')

  const items = conversation.messages.map((message) => (
    <div
      key={`message:${message.id}`}
      ref={(element) => {
        if (element) messageElementsRef.current.set(message.id, element)
        else messageElementsRef.current.delete(message.id)
      }}
      data-testid="conversation-message"
      data-message-id={message.id}
      data-active-message={activeMessageId === message.id ? 'true' : undefined}
      aria-current={activeMessageId === message.id ? 'true' : undefined}
      data-latest-conversation-item={!inlineComposer && activeMessageId === message.id ? '' : undefined}
      className="relative"
      onPointerDownCapture={() => {
        if (!inlineComposer) setActiveMessageId(message.id)
      }}
      onFocusCapture={() => {
        if (!inlineComposer) setActiveMessageId(message.id)
      }}
    >
      {activeMessageId === message.id && (
        <span
          data-testid="message-cursor"
          aria-hidden
          className="pointer-events-none absolute top-[21px] -left-2.5 z-10 h-[18px] w-0.5 rounded-full bg-accent"
        />
      )}
      {message.trashed && !revealedTrashedIds.has(message.id) ? (
        <div
          data-testid="trashed-message-marker"
          className="flex items-center gap-2 rounded-lg border border-edge border-dashed px-4 py-2.5 text-xs text-ink-faint"
        >
          This message was moved to Trash.
          <button
            type="button"
            data-testid="trashed-message-reveal"
            onClick={(event) => {
              revealTrashed(message.id)
              event.currentTarget.blur()
            }}
            className="cursor-pointer font-medium text-accent hover:underline"
          >
            Show message
          </button>
        </div>
      ) : (
        <MessageCard
          threadId={conversation.threadId}
          message={message}
          account={account}
          active={activeMessageId === message.id}
          bodyHydrationMessage={bodyHydrationStatusMessage(
            message.bodyState,
            online,
            conversation.bodyHydrationFailed
          )}
          collapsed={!expandedMessageIds.has(message.id)}
          onToggleCollapsed={() => toggleMessage(message.id)}
          trimExpanded={expandedTrimIds.has(message.id)}
          onToggleTrim={() => toggleTrim(message.id)}
          onReply={onReply && !message.pending ? (kind) => replyToMessage(kind, message.id) : undefined}
        />
      )}
    </div>
  ))
  if (inlineComposer) {
    const sourceIndex = conversation.messages.findIndex(
      (message) => message.id === inlineComposerSourceMessageId
    )
    items.splice(
      sourceIndex < 0 ? items.length : sourceIndex + 1,
      0,
      <div
        key="composer"
        data-testid="conversation-latest-item"
        data-composer-source-message-id={inlineComposerSourceMessageId ?? undefined}
        data-latest-conversation-item=""
        className="relative ml-10 mt-4 mb-6"
      >
        {inlineComposer}
      </div>
    )
  }
  return (
    <>
      <div
        data-testid="conversation-summary"
        className="mb-5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-ink-dim"
      >
        <span className="shrink-0">
          {conversation.messages.length} {conversation.messages.length === 1 ? 'message' : 'messages'}
        </span>
        <span aria-hidden>·</span>
        <span className="max-w-64 min-w-0 truncate">{participants}</span>
        {labels
          .filter((label) => labelIds.includes(label.id))
          .map((label) => (
            <button
              type="button"
              key={label.id}
              onClick={() => onOpenLabel(label.id)}
              className="max-w-24 truncate rounded border px-1.5 py-0.5 text-[10px]"
              style={labelColor(label.id)}
            >
              {label.name}
            </button>
          ))}
        {readableMessages.length > 1 && (
          <Button data-testid="conversation-toggle-all" className="ml-auto" onClick={toggleAll}>
            {allExpanded ? 'Collapse all messages' : 'Expand all messages'}
          </Button>
        )}
      </div>
      {items}
    </>
  )
}

interface ConversationViewProps {
  selected: DisplayThread
  selectedIndex: number
  threadCount: number
  threadCountExact: boolean
  mailboxTitle: string
  conversation: DisplayConversation | null
  labels: readonly MailLabel[]
  onOpenLabel: (labelId: string) => void
  account: string | null
  online: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  replyTargetRef: React.RefObject<MessageReplyTarget | null>
  inlineComposer: ReactNode | null
  inlineComposerDraftId: string | null
  inlineComposerSourceMessageId: string | null
  onClose: () => void
  onReply: (kind: Exclude<DraftKind, 'new'>, messageId: string) => void
}

export const ConversationView = memo(function ConversationView(
  props: ConversationViewProps
): React.JSX.Element {
  const {
    selected,
    selectedIndex,
    threadCount,
    threadCountExact,
    mailboxTitle,
    conversation,
    account,
    online,
    scrollRef,
    replyTargetRef,
    inlineComposer,
    inlineComposerDraftId,
    inlineComposerSourceMessageId,
    onClose,
    onReply
  } = props

  const conversationThreadId = conversation?.threadId ?? (inlineComposer ? selected.id : null)
  const newestMessageId = conversation?.messages.at(-1)?.id ?? null
  const newestMessagePending = conversation?.messages.at(-1)?.pending === true
  const pendingFocusMessageId = newestMessagePending && inlineComposer === null ? newestMessageId : null
  const latestTargetKey = conversationThreadId
    ? `${conversationThreadId}:${pendingFocusMessageId ?? ''}:${inlineComposerDraftId ?? ''}`
    : null

  useLayoutEffect(() => {
    if (!latestTargetKey) return
    const scroll = scrollRef.current
    const content = scroll?.querySelector<HTMLElement>('[data-testid="conversation-content"]')
    if (!scroll || !content) return

    let tracking = true
    let frame = 0
    const alignLatest = (): void => {
      if (!tracking) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const target = content.querySelector<HTMLElement>('[data-latest-conversation-item]')
        if (!target) return
        const scrollRect = scroll.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const paddingTop = Number.parseFloat(getComputedStyle(scroll).paddingTop) || 0
        const sourceId = target.dataset.composerSourceMessageId
        const source = sourceId
          ? [...content.querySelectorAll<HTMLElement>('[data-message-id]')].find(
              (message) => message.dataset.messageId === sourceId
            )
          : null
        const sourceRect = source?.getBoundingClientRect()
        // Keep the source visible above a reply when it fits. For long mail,
        // retain a little context without pushing the editor out of view.
        const targetTop = sourceRect
          ? Math.max(
              sourceRect.top,
              targetRect.top - Math.max(140, scroll.clientHeight - targetRect.height - paddingTop * 2)
            )
          : target === content.querySelector('[data-testid="conversation-message"]')
            ? content.getBoundingClientRect().top
            : targetRect.top
        // Move only the conversation pane. `scrollIntoView()` also scrolls the
        // document's root scrolling element, which pulls the app shell above
        // the Electron window and strands both footers mid-window.
        scroll.scrollTop += targetTop - scrollRect.top - paddingTop
      })
    }
    const observer = new ResizeObserver(alignLatest)
    observer.observe(content)
    const stopTracking = (): void => {
      tracking = false
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
    scroll.addEventListener('wheel', stopTracking, { passive: true, once: true })
    scroll.addEventListener('touchstart', stopTracking, { passive: true, once: true })
    scroll.addEventListener('pointerdown', stopTracking, { passive: true, once: true })
    window.addEventListener('keydown', stopTracking, { once: true })
    alignLatest()

    return () => {
      stopTracking()
      scroll.removeEventListener('wheel', stopTracking)
      scroll.removeEventListener('touchstart', stopTracking)
      scroll.removeEventListener('pointerdown', stopTracking)
      window.removeEventListener('keydown', stopTracking)
    }
  }, [latestTargetKey, scrollRef])

  // The editor owned keyboard focus until the queued send unmounted it. Give
  // that focus back to the reader as soon as the optimistic message appears so
  // its expanded card is both visible and the active keyboard context during
  // the undo window.
  useLayoutEffect(() => {
    if (!pendingFocusMessageId) return
    scrollRef.current?.focus({ preventScroll: true })
  }, [pendingFocusMessageId, scrollRef])

  const hadInlineComposer = useRef(Boolean(inlineComposer))
  useLayoutEffect(() => {
    if (hadInlineComposer.current && !inlineComposer) scrollRef.current?.focus({ preventScroll: true })
    hadInlineComposer.current = Boolean(inlineComposer)
  }, [inlineComposer, scrollRef])

  return (
    <section data-testid="conversation-view" className="flex min-w-0 flex-1 flex-col bg-ground">
      <div className="overflow-y-hidden px-6 [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-[896px] items-start gap-4 pt-6 pb-3">
          <h1
            data-testid="conversation-subject"
            className="min-w-0 flex-1 break-words text-xl font-semibold tracking-tight"
          >
            {conversation?.subject ?? selected.subject}
          </h1>
          <span className="flex flex-none items-center gap-2 text-xs text-ink-faint">
            <span data-testid="conversation-position" className="tabular-nums">
              {selectedIndex + 1} of {threadCount}
              {threadCountExact ? '' : '+'}
            </span>{' '}
            {!inlineComposer && (
              <Button
                data-testid="conversation-back"
                aria-label={`Back to ${mailboxTitle}`}
                data-tooltip=""
                onClick={onClose}
                className="cursor-pointer rounded-md px-2 py-1 hover:bg-active hover:text-ink"
              >
                Back to {mailboxTitle} <Kbd>Esc</Kbd>
              </Button>
            )}
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-testid="conversation-scroll"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5 focus:outline-none [scrollbar-gutter:stable]"
      >
        {conversation || inlineComposer ? (
          <div data-testid="conversation-content" className="mx-auto flex w-full max-w-[896px] flex-col">
            <ConversationMessages
              key={selected.id}
              conversation={
                conversation ?? {
                  threadId: selected.id,
                  subject: selected.subject,
                  messages: [],
                  bodyHydrationFailed: false
                }
              }
              labels={props.labels}
              labelIds={selected.labelIds}
              onOpenLabel={props.onOpenLabel}
              account={account}
              online={online}
              inlineComposer={inlineComposer}
              inlineComposerSourceMessageId={inlineComposerSourceMessageId}
              scrollRef={scrollRef}
              replyTargetRef={replyTargetRef}
              onReply={inlineComposer === null ? onReply : undefined}
            />
          </div>
        ) : (
          <div data-testid="conversation-loading" className="py-10 text-center text-ink-faint">
            Loading…
          </div>
        )}
      </div>
    </section>
  )
})
