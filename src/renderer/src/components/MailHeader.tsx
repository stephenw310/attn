interface MailHeaderProps {
  view: 'inbox' | 'snoozed'
  unreadCount: number | null
  selectionCount: number
  queueReadout: React.ReactNode
  accountMenu: React.ReactNode
  onSwitchView: (view: 'inbox' | 'snoozed') => void
}

export function MailHeader(props: MailHeaderProps): React.JSX.Element {
  const { view, unreadCount, selectionCount, queueReadout, accountMenu, onSwitchView } = props
  return (
    <header className="app-drag flex items-center gap-6 border-b border-edge px-6 py-3">
      <div className="text-base font-bold tracking-tight">
        attn<span className="text-accent">:</span>
      </div>
      <nav className="app-no-drag flex gap-1">
        <button
          type="button"
          onClick={() => onSwitchView('inbox')}
          className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
            view === 'inbox' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
          }`}
        >
          <span data-testid={view === 'inbox' ? 'view-title' : undefined}>Inbox</span>
          {unreadCount !== null && unreadCount > 0 && (
            <span className="ml-1.5 text-xs font-semibold text-accent tabular-nums">{unreadCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onSwitchView('snoozed')}
          className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
            view === 'snoozed' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
          }`}
        >
          <span data-testid={view === 'snoozed' ? 'view-title' : undefined}>Snoozed</span>
        </button>
      </nav>
      <div className="app-no-drag ml-auto flex items-center gap-4">
        {selectionCount > 0 && (
          <span
            data-testid="selection-count"
            className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent tabular-nums"
          >
            {selectionCount} selected
          </span>
        )}
        {queueReadout}
        {accountMenu}
      </div>
    </header>
  )
}
