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
      {/* A full-window composer takes the whole page, sidebar included. The
          toggle would then say it collapses something that is not there, and
          pressing it would move a preference with nothing to show for it. */}
      {!composerOpen && (
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
      )}
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
        {/* The account keeps one home, at the top right, clear of the torn edge
            the sidebar's band leaves down the left. */}
        <AccountMenu
          status={status}
          accountStatuses={accountStatuses}
          onSwitchAccount={onSwitchAccount}
          onAddAccount={onAddAccount}
          onRemoveAccount={onRemoveAccount}
          onOpenSettings={onOpenSettings}
          onOpenCheatSheet={onOpenCheatSheet}
          accountActionsBlocked={accountActionsBlocked}
        />
      </div>
    </header>
  )
}
