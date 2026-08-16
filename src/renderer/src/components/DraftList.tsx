import type { Draft } from '../../../shared/drafts'

interface DraftListProps {
  drafts: readonly Draft[]
  readerOpen: boolean
  selectedIndex: number
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  onOpen: (index: number) => void
}

function recipientLabel(draft: Draft): string {
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
  if (recipients.length === 0) return draft.kind === 'forward' ? 'Forward' : 'No recipients'
  return recipients.map((address) => address.name || address.email).join(', ')
}

export function DraftList({
  drafts,
  readerOpen,
  selectedIndex,
  selectedRowRef,
  onOpen
}: DraftListProps): React.JSX.Element {
  return (
    <main
      data-testid="draft-list"
      className={`min-h-0 flex-1 overflow-y-auto py-2 ${readerOpen ? 'hidden' : ''}`}
      aria-label="Drafts"
    >
      {drafts.length === 0 && (
        <div className="flex h-full items-center justify-center text-ink-faint">No drafts</div>
      )}
      {drafts.map((draft, index) => {
        const selected = index === selectedIndex
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is provided by the command registry
          // biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is provided by the command registry
          <div
            key={draft.id}
            ref={selected ? selectedRowRef : null}
            data-testid="draft-row"
            data-draft-id={draft.id}
            data-selected={selected || undefined}
            className={`flex cursor-default select-none items-center gap-4 border-l-[3px] py-3 pr-7 pl-5 ${
              selected ? 'border-l-accent bg-accent/[0.07]' : 'border-l-transparent'
            }`}
            onClick={() => onOpen(index)}
          >
            <span className="w-52 flex-none truncate text-sm text-ink-dim">{recipientLabel(draft)}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
              {draft.subject || '(no subject)'}
            </span>
            <span className="text-xs capitalize text-ink-faint">
              {draft.kind === 'replyAll' ? 'reply all' : draft.kind}
            </span>
          </div>
        )
      })}
    </main>
  )
}
