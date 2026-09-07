import type { AccountSyncStatus, AuthStatus } from '../../../shared/auth'
import { isMacPlatform, modKeyLabel } from '../platform'
import { AccountMenu } from './AccountMenu'
import { MailActivity } from './MailActivity'

interface MailHeaderProps {
  pendingActionCount: number
  pausedActionCount: number
  outboxCount: number
  selectionCount: number
  composerOpen: boolean
  sidebarCollapsed: boolean
  /** True whenever the sidebar is off screen — collapsed, or hidden behind a
      full-window composer — and the account line has nowhere else to sit. */
  accountInHeader: boolean
  status: AuthStatus
  accountStatuses: readonly AccountSyncStatus[] | null
  onReconnectActions: () => void
  onOpenOutbox: () => void
  onToggleSidebar: () => void
  onSwitchAccount: (accountId: string) => void
  onAddAccount: () => void
  onRemoveAccount: () => void
  onOpenSettings: () => void
  onOpenCheatSheet: () => void
  accountActionsBlocked: boolean
}

export function MailHeader(props: MailHeaderProps): React.JSX.Element {
  const {
    pendingActionCount,
    pausedActionCount,
    outboxCount,
    selectionCount,
    composerOpen,
    sidebarCollapsed,
    accountInHeader,
    status,
    accountStatuses,
    onReconnectActions,
    onOpenOutbox,
    onToggleSidebar,
    onSwitchAccount,
    onAddAccount,
    onRemoveAccount,
    onOpenSettings,
    onOpenCheatSheet,
    accountActionsBlocked
  } = props
  const sidebarAction = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const sidebarShortcut = `${modKeyLabel()}B`
  return (
    <header
      data-testid="mail-header"
      className="app-drag app-titlebar-safe-area flex h-11 flex-none items-center gap-6"
    >
      <button
        type="button"
        data-testid="sidebar-toggle"
        data-state={sidebarCollapsed ? 'collapsed' : 'expanded'}
        aria-label={sidebarAction}
        aria-keyshortcuts={isMacPlatform() ? 'Meta+B' : 'Control+B'}
        aria-controls="mail-sidebar"
        aria-expanded={!sidebarCollapsed}
        title={`${sidebarAction} (${sidebarShortcut})`}
        onClick={(event) => {
          onToggleSidebar()
          event.currentTarget.blur()
        }}
        className="app-no-drag flex size-7 cursor-pointer items-center justify-center text-ink-faint hover:bg-active hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current">
          <rect x="3" y="4" width="18" height="16" rx="2.5" strokeWidth="1.75" />
          <path d="M8.5 4v16" strokeWidth="1.75" />
        </svg>
      </button>
      {/* The queue readouts stay on this bar rather than beside the view title:
          they have to stay in sight while the reader is open, and the title
          row belongs to the list. */}
      <div className="app-no-drag ml-auto flex items-center gap-5">
        {!composerOpen && selectionCount > 0 && (
          <span data-testid="selection-count" className="app-figures text-[15px] font-semibold text-accent">
            {selectionCount} selected
          </span>
        )}
        <MailActivity
          pendingActions={pendingActionCount}
          pausedActions={pausedActionCount}
          outbox={outboxCount}
          onReconnect={onReconnectActions}
          onOpenOutbox={composerOpen ? undefined : onOpenOutbox}
        />
        {/* The account line lives at the foot of the sidebar; it comes back up
            here whenever the sidebar is off screen. */}
        {accountInHeader && (
          <AccountMenu
            placement="header"
            status={status}
            accountStatuses={accountStatuses}
            onSwitchAccount={onSwitchAccount}
            onAddAccount={onAddAccount}
            onRemoveAccount={onRemoveAccount}
            onOpenSettings={onOpenSettings}
            onOpenCheatSheet={onOpenCheatSheet}
            accountActionsBlocked={accountActionsBlocked}
          />
        )}
      </div>
    </header>
  )
}
