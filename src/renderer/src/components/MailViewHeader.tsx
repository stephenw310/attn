interface MailViewHeaderProps {
  title: string
  count: number
  kind: 'conversations' | 'drafts' | 'messages'
  inbox: boolean
  outbox: boolean
  sidebarCollapsed: boolean
  onBackOutbox: () => void
}

export function MailViewHeader(props: MailViewHeaderProps): React.JSX.Element {
  const { title, count, kind, inbox, outbox, sidebarCollapsed, onBackOutbox } = props
  const noun = count === 1 ? kind.slice(0, -1) : kind

  return (
    <div
      data-testid="mail-view-header"
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      className={`flex min-h-13 items-center gap-3 border-b border-edge pr-6 ${
        sidebarCollapsed ? 'pl-[54px]' : 'pl-6'
      }`}
    >
      {outbox ? (
        <button
          type="button"
          data-testid="outbox-back"
          className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          onClick={onBackOutbox}
        >
          ← Back
        </button>
      ) : null}
      <h1 data-testid="mailbox-title" className="text-sm font-semibold text-ink">
        <span data-testid="view-title">{title}</span>
      </h1>
      <span className="text-xs text-ink-faint tabular-nums">
        {count} {noun}
      </span>
      {inbox ? (
        <nav className="min-w-0 flex-1" data-testid="split-strip" aria-label="Inbox splits" />
      ) : (
        <div className="min-w-0 flex-1" />
      )}
    </div>
  )
}
