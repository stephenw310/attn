import { useLayoutEffect, useRef } from 'react'
import type { MailAddress } from '../../../shared/mail'

/** Who a queued or drafted message is addressed to, in one line. */
export function recipientLabel(recipients: readonly MailAddress[][], emptyLabel = 'No recipients'): string {
  const addresses = recipients.flat()
  if (addresses.length === 0) return emptyLabel
  return addresses.map((address) => address.name || address.email).join(', ')
}

interface SimpleRowListProps<T> {
  testId: string
  ariaLabel: string
  /** The scroll container, so the shell can save and restore its offset. */
  listRef: React.RefObject<HTMLElement | null>
  containerClassName: string
  /** Drafts pad the scroll container; the outbox pads an inner block. */
  rowsClassName?: string
  /** Drafts take focus while search results drive the cursor from the field. */
  focusable?: boolean
  emptyLabel: string
  rows: readonly T[]
  rowKey: (row: T) => string
  rowTestId: string
  /** The row's own data-* attributes, which the e2e suite selects on. */
  rowData: (row: T) => Record<string, string | undefined>
  recipients: (row: T) => string
  subject: (row: T) => string
  /** Whatever the list shows after the subject: a state chip, an error. */
  trailing: (row: T) => React.ReactNode
  selectedIndex: number
  selectionVisible?: boolean
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  onOpen: (index: number) => void
}

/**
 * The flat recipient / subject / trailing list the Drafts and Outbox views
 * share. Unlike ThreadList there is no windowing and no grouping here, so
 * keeping the cursor visible is one scrollIntoView and lives with the rows
 * rather than in the shell above them.
 */
export function SimpleRowList<T>({
  testId,
  ariaLabel,
  listRef,
  containerClassName,
  rowsClassName,
  focusable = false,
  emptyLabel,
  rows,
  rowKey,
  rowTestId,
  rowData,
  recipients,
  subject,
  trailing,
  selectedIndex,
  selectionVisible = true,
  selectedRowRef,
  onOpen
}: SimpleRowListProps<T>): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the index is the trigger; the row element is read fresh
  useLayoutEffect(() => {
    rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex])

  const body = rows.map((row, index) => {
    const selected = index === selectedIndex
    const selectionShown = selectionVisible && selected
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is provided by the command registry
      // biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is provided by the command registry
      <div
        key={rowKey(row)}
        ref={(element) => {
          if (!selected) return
          rowRef.current = element
          selectedRowRef.current = element
        }}
        data-testid={rowTestId}
        {...rowData(row)}
        data-selected={selectionShown || undefined}
        className={`flex min-h-[66px] cursor-default select-none items-center gap-4 rounded-md py-3 px-3 ${
          selectionShown ? 'bg-active' : 'hover:bg-active/50'
        }`}
        onClick={() => onOpen(index)}
      >
        <span className="w-52 flex-none truncate text-sm text-ink-dim">{recipients(row)}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{subject(row)}</span>
        {trailing(row)}
      </div>
    )
  })

  return (
    <main
      ref={listRef}
      data-testid={testId}
      aria-label={ariaLabel}
      {...(focusable ? { tabIndex: -1 } : {})}
      className={containerClassName}
    >
      {rows.length === 0 && (
        <div className="flex h-full items-center justify-center text-ink-faint">{emptyLabel}</div>
      )}
      {rowsClassName ? <div className={rowsClassName}>{body}</div> : body}
    </main>
  )
}
