import { useCallback, useLayoutEffect, useState } from 'react'
import { bodyHydrationStatusMessage } from '../bodyHydrationStatus'
import { createCommand, registerCommands } from '../commands'
import type { DisplayConversation, DisplayThread } from '../mailDisplay'
import { Kbd } from './Kbd'
import { MessageCard } from './MessageCard'

interface ConversationMessagesProps {
  conversation: DisplayConversation
  account: string | null
  online: boolean
  onToast: (message: string) => void
}

function ConversationMessages(props: ConversationMessagesProps): React.JSX.Element {
  const { conversation, account, online, onToast } = props
  const newestIndex = conversation.messages.length - 1
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => {
    const newestMessage = conversation.messages[newestIndex]
    return new Set(newestMessage ? [newestMessage.id] : [])
  })
  const [expandedTrimIds, setExpandedTrimIds] = useState<Set<string>>(() => new Set())

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

  return (
    <>
      {conversation.messages.map((message) => (
        <MessageCard
          key={message.id}
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
      ))}
    </>
  )
}

interface ConversationViewProps {
  selected: DisplayThread
  selectedIndex: number
  threadCount: number
  view: 'inbox' | 'snoozed'
  conversation: DisplayConversation | null
  account: string | null
  online: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onToast: (message: string) => void
}

export function ConversationView(props: ConversationViewProps): React.JSX.Element {
  const {
    selected,
    selectedIndex,
    threadCount,
    view,
    conversation,
    account,
    online,
    scrollRef,
    onClose,
    onToast
  } = props
  return (
    <section data-testid="conversation-view" className="flex min-w-0 flex-1 flex-col bg-raised/35">
      <div className="flex items-center gap-4 border-b border-edge px-6 pt-3 pb-3">
        <button
          type="button"
          data-testid="conversation-back"
          className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          onClick={onClose}
        >
          <span aria-hidden>←</span> {view === 'inbox' ? 'Inbox' : 'Snoozed'}
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
        {conversation ? (
          <div
            data-testid="conversation-content"
            className="mx-auto flex w-full flex-col gap-3.5"
            style={{ maxWidth: 'clamp(720px, 72vw, 1120px)' }}
          >
            <ConversationMessages
              key={conversation.threadId}
              conversation={conversation}
              account={account}
              online={online}
              onToast={onToast}
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
}
