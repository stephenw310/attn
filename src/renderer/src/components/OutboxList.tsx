import type { OutboxItem } from '../../../shared/outbox'

interface OutboxListProps {
  items: readonly OutboxItem[]
  selectedIndex: number
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  onBack: () => void
  onOpen: (index: number) => void
}

function recipientLabel(item: OutboxItem): string {
  const recipients = [...item.to, ...item.cc, ...item.bcc]
  return recipients.length > 0
    ? recipients.map((address) => address.name || address.email).join(', ')
    : 'No recipients'
}

function stateLabel(state: OutboxItem['state']): string {
  if (state === 'needs-review') return 'needs review'
  return state
}

export function OutboxList({
  items,
  selectedIndex,
  selectedRowRef,
  onBack,
  onOpen
}: OutboxListProps): React.JSX.Element {
  return (
    <main data-testid="outbox-list" className="min-h-0 flex-1 overflow-y-auto" aria-label="Outbox">
      <div className="flex min-h-14 items-center gap-3 border-b border-edge px-6">
        <button
          type="button"
          data-testid="outbox-back"
          className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          onClick={onBack}
        >
          ← Back
        </button>
        <h1 data-testid="view-title" className="text-sm font-semibold text-ink">
          Outbox
        </h1>
        <span className="text-xs text-ink-faint">queued, sending, and messages needing attention</span>
      </div>
      {items.length === 0 && (
        <div className="flex h-[calc(100%-3.5rem)] items-center justify-center text-ink-faint">
          Outbox is clear
        </div>
      )}
      <div className="py-2">
        {items.map((item, index) => {
          const selected = index === selectedIndex
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is provided by the command registry
            // biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is provided by the command registry
            <div
              key={item.id}
              ref={selected ? selectedRowRef : null}
              data-testid="outbox-row"
              data-outbox-id={item.id}
              data-outbox-state={item.state}
              data-send-at={item.sendAt ?? undefined}
              data-selected={selected || undefined}
              className={`flex cursor-default select-none items-center gap-4 border-l-[3px] py-3 pr-7 pl-5 ${
                selected ? 'border-l-accent bg-accent/[0.07]' : 'border-l-transparent'
              }`}
              onClick={() => onOpen(index)}
            >
              <span className="w-52 flex-none truncate text-sm text-ink-dim">{recipientLabel(item)}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {item.subject || '(no subject)'}
              </span>
              {/* Reading why a send failed must not require opening the row,
                  because opening it moves the message back to composing. */}
              {item.lastError ? (
                <span
                  data-testid="outbox-error"
                  className="min-w-0 max-w-72 flex-none truncate text-xs text-ink-dim"
                  title={item.lastError}
                >
                  {item.lastError}
                </span>
              ) : null}
              <span
                className={`text-xs capitalize ${
                  item.state === 'failed' || item.state === 'needs-review' ? 'text-danger' : 'text-ink-faint'
                }`}
              >
                {stateLabel(item.state)}
              </span>
            </div>
          )
        })}
      </div>
    </main>
  )
}
