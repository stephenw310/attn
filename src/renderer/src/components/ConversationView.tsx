import type { DisplayConversation, DisplayThread } from './Inbox'

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[5px] border border-edge bg-active px-1.5 py-px text-[10.5px] font-medium text-ink-dim">
      {children}
    </kbd>
  )
}

interface ConversationViewProps {
  selected: DisplayThread
  selectedIndex: number
  threadCount: number
  view: 'inbox' | 'snoozed'
  conversation: DisplayConversation | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  renderMessages: (conversation: DisplayConversation) => React.ReactNode
}

export function ConversationView(props: ConversationViewProps): React.JSX.Element {
  const { selected, selectedIndex, threadCount, view, conversation, scrollRef, onClose, renderMessages } =
    props
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
            {renderMessages(conversation)}
          </div>
        ) : (
          <div className="py-10 text-center text-ink-faint">Loading…</div>
        )}
      </div>
    </section>
  )
}
