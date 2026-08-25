import { memo, type ReactNode, useCallback, useLayoutEffect, useState } from 'react'
import { bodyHydrationStatusMessage } from '../bodyHydrationStatus'
import { createCommand, registerCommands } from '../commands'
import type { DisplayConversation, DisplayThread } from '../mailDisplay'
import { Kbd } from './Kbd'
import { MessageCard } from './MessageCard'

interface ConversationMessagesProps {
  conversation: DisplayConversation
  account: string | null
  online: boolean
  markNewest: boolean
  onToast: (message: string) => void
}

/** The newest message a reader expands: trashed markers stay compact (SPEC F3). */
function newestReadableIndex(messages: readonly DisplayConversation['messages'][number][]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!messages[index].trashed) return index
  }
  return messages.length - 1
}

function ConversationMessages(props: ConversationMessagesProps): React.JSX.Element {
  const { conversation, account, online, markNewest, onToast } = props
  const newestIndex = newestReadableIndex(conversation.messages)
  const newestMessageId = conversation.messages[newestIndex]?.id
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => {
    return new Set(newestMessageId ? [newestMessageId] : [])
  })
  const [expandedTrimIds, setExpandedTrimIds] = useState<Set<string>>(() => new Set())
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

  useLayoutEffect(() => {
    const newestMessage = conversation.messages[newestIndex]
    if (!newestMessage) return
    return registerCommands([createCommand('message.trim.toggle', () => toggleTrim(newestMessage.id))])
  }, [conversation.messages, newestIndex, toggleTrim])

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

  return (
    <>
      {conversation.messages.map((message, index) => (
        <div
          key={message.id}
          data-latest-conversation-item={markNewest && index === newestIndex ? '' : undefined}
        >
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
              onToast={onToast}
              bodyHydrationMessage={bodyHydrationStatusMessage(
                message.bodyState,
                online,
                conversation.bodyHydrationFailed
              )}
              collapsed={!expandedMessageIds.has(message.id)}
              onToggleCollapsed={() => toggleMessage(message.id)}
              trimExpanded={expandedTrimIds.has(message.id)}
              onToggleTrim={() => toggleTrim(message.id)}
            />
          )}
        </div>
      ))}
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
  account: string | null
  online: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  inlineComposer: ReactNode | null
  inlineComposerDraftId: string | null
  onClose: () => void
  onToast: (message: string) => void
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
    inlineComposer,
    inlineComposerDraftId,
    onClose,
    onToast
  } = props

  const conversationThreadId = conversation?.threadId ?? (inlineComposer ? selected.id : null)
  const newestMessageId = conversation?.messages.at(-1)?.id ?? null
  const newestMessagePending = conversation?.messages.at(-1)?.pending === true
  const pendingFocusMessageId = newestMessagePending && inlineComposer === null ? newestMessageId : null
  const messageCount = conversation?.messages.length ?? 0
  const latestTargetKey = conversationThreadId
    ? `${conversationThreadId}:${messageCount}:${newestMessageId ?? ''}:${inlineComposerDraftId ?? ''}`
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
        // Move only the conversation pane. `scrollIntoView()` also scrolls the
        // document's root scrolling element, which pulls the app shell above
        // the Electron window and strands both footers mid-window.
        scroll.scrollTop += targetRect.top - scrollRect.top - paddingTop
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

  return (
    <section data-testid="conversation-view" className="flex min-w-0 flex-1 flex-col bg-raised/35">
      <div className="flex items-center gap-4 border-b border-edge px-6 pt-3 pb-3">
        <button
          type="button"
          data-testid="conversation-back"
          className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          onClick={onClose}
        >
          <span aria-hidden>←</span> {mailboxTitle}
        </button>
        <h1
          data-testid="conversation-subject"
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-lg font-bold tracking-tight"
        >
          {conversation?.subject ?? selected.subject}
        </h1>
        <span className="flex flex-none items-center gap-2 text-xs text-ink-faint">
          <span data-testid="conversation-position" className="tabular-nums">
            {selectedIndex + 1} of {threadCount}
            {threadCountExact ? '' : '+'}
          </span>{' '}
          · <Kbd>Esc</Kbd>
        </span>
      </div>
      <div
        ref={scrollRef}
        data-testid="conversation-scroll"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5 focus:outline-none [scrollbar-gutter:stable]"
      >
        {conversation || inlineComposer ? (
          <div
            data-testid="conversation-content"
            className="mx-auto flex w-full flex-col gap-3.5"
            style={{ maxWidth: 'clamp(720px, 72vw, 1120px)' }}
          >
            {conversation ? (
              <ConversationMessages
                key={conversation.threadId}
                conversation={conversation}
                account={account}
                online={online}
                markNewest={inlineComposer === null}
                onToast={onToast}
              />
            ) : null}
            {inlineComposer ? (
              <div data-testid="conversation-latest-item" data-latest-conversation-item="">
                {inlineComposer}
              </div>
            ) : null}
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
