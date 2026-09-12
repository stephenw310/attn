import { useLayoutEffect, useRef } from 'react'
import { NEEDS_REVIEW_EXPLANATION, type OutboxItem } from '../../../shared/outbox'
import { Button } from './Button'
import { recipientLabel } from './SimpleRowList'

interface OutboxListProps {
  items: readonly OutboxItem[]
  selectedIndex: number
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  listRef: React.RefObject<HTMLElement | null>
  onOpen: (index: number) => void
}

export function OutboxList({
  items,
  selectedIndex,
  selectedRowRef,
  listRef,
  onOpen
}: OutboxListProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: move the selected row into view when navigation changes
  useLayoutEffect(() => {
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])
  return (
    <main
      ref={listRef}
      data-testid="outbox-list"
      aria-label="Outbox"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2"
    >
      {items.length > 0 && (
        <p className="px-3 pb-4 text-xs text-ink-dim">Messages waiting to send or needing your attention.</p>
      )}
      {items.length === 0 && (
        <div
          data-testid="outbox-empty"
          className="flex flex-1 items-center justify-center text-sm text-ink-dim"
        >
          Outbox is clear
        </div>
      )}
      {items.map((item, index) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Enter uses the outbox command
        // biome-ignore lint/a11y/noStaticElementInteractions: the row action is also a focusable button
        <div
          key={item.id}
          onClick={() => onOpen(index)}
          ref={(element) => {
            if (index === selectedIndex) {
              rowRef.current = element
              selectedRowRef.current = element
            }
          }}
          data-testid="outbox-row"
          data-outbox-id={item.id}
          data-outbox-state={item.state}
          data-send-at={item.sendAt ?? undefined}
          data-selected={index === selectedIndex || undefined}
          className={`flex items-start gap-4 border-b border-edge px-3 py-4 ${index === selectedIndex ? 'bg-active/60' : 'hover:bg-active/30'}`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">
              {item.subject.trim() ? item.subject : '(no subject)'}
            </div>
            <div className="mt-1 truncate text-xs text-ink-dim">
              To {recipientLabel([item.to, item.cc, item.bcc])}
            </div>
            <div
              className={`mt-1 text-xs ${item.state === 'failed' || item.state === 'needs-review' ? 'text-danger' : 'text-ink-dim'}`}
            >
              {item.state === 'needs-review'
                ? 'Needs review · Sending outcome is uncertain'
                : item.state === 'failed'
                  ? 'Send failed · Message was not sent'
                  : item.state === 'sending'
                    ? 'Sending…'
                    : 'Queued · Waiting to send'}
            </div>
            {(item.lastError || item.state === 'needs-review') && (
              <p data-testid="outbox-error" className="mt-1 max-w-xl text-xs text-ink-dim">
                {item.lastError || NEEDS_REVIEW_EXPLANATION}
              </p>
            )}
          </div>
          <Button
            data-testid="outbox-open"
            disabled={item.state === 'sending'}
            onClick={(event) => {
              event.stopPropagation()
              onOpen(index)
            }}
          >
            {item.state === 'needs-review'
              ? 'Review'
              : item.state === 'failed'
                ? 'Edit & retry'
                : item.state === 'sending'
                  ? 'Sending'
                  : 'Undo send'}
          </Button>
        </div>
      ))}
    </main>
  )
}
