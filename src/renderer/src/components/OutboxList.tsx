import type { OutboxItem } from '../../../shared/outbox'
import { recipientLabel, SimpleRowList } from './SimpleRowList'

interface OutboxListProps {
  items: readonly OutboxItem[]
  selectedIndex: number
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  listRef: React.RefObject<HTMLElement | null>
  onOpen: (index: number) => void
}

function stateLabel(state: OutboxItem['state']): string {
  if (state === 'needs-review') return 'needs review'
  return state
}

export function OutboxList({
  items,
  selectedIndex,
  selectedRowRef,
  listRef,
  onOpen
}: OutboxListProps): React.JSX.Element {
  return (
    <SimpleRowList
      testId="outbox-list"
      ariaLabel="Outbox"
      listRef={listRef}
      containerClassName="min-h-0 flex-1 overflow-y-auto"
      rowsClassName="py-2"
      emptyLabel="Outbox is clear"
      rows={items}
      rowKey={(item) => item.id}
      rowTestId="outbox-row"
      rowData={(item) => ({
        'data-outbox-id': item.id,
        'data-outbox-state': item.state,
        'data-send-at': item.sendAt === null ? undefined : String(item.sendAt)
      })}
      recipients={(item) => recipientLabel([item.to, item.cc, item.bcc])}
      subject={(item) => item.subject || '(no subject)'}
      trailing={(item) => (
        <>
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
        </>
      )}
      selectedIndex={selectedIndex}
      selectedRowRef={selectedRowRef}
      onOpen={onOpen}
    />
  )
}
