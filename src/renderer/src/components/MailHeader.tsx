import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSyncStatus, AuthStatus } from '../../../shared/auth'
import { THEME_OPTIONS, type ThemePreference } from '../../../shared/theme'
import { accountNeedsAttention, useAccountHealth } from '../hooks/useAccountHealth'
import { isMacPlatform, modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { AccountHealthLine } from './AccountHealthLine'
import { Button } from './Button'
import { blurActive } from './blurActive'
import { Kbd } from './Kbd'
import { MailIcon } from './MailIcon'
import { PalettePicker } from './PalettePicker'

const CHIP_CLASS = 'app-no-drag app-button max-w-56 truncate'

function MailActivity({
  pendingActions,
  pausedActions,
  outbox,
  onReconnect,
  onOpenOutbox
}: {
  pendingActions: number
  pausedActions: number
  outbox: number
  onReconnect: () => void
  onOpenOutbox?: () => void
}): React.JSX.Element | null {
  if (pendingActions === 0 && pausedActions === 0 && outbox === 0) return null
  return (
    <div data-testid="mail-activity" className="flex items-center gap-3 text-xs text-ink-faint">
      {pendingActions > 0 && (
        <span data-testid="pending-count" className="font-medium tabular-nums">
          {pendingActions} pending
        </span>
      )}
      {outbox > 0 && (
        <button
          type="button"
          data-testid="outbox-count"
          disabled={!onOpenOutbox}
          className="cursor-pointer rounded px-1 py-0.5 hover:bg-active hover:text-ink-dim disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-inherit"
          onClick={onOpenOutbox}
        >
          {outbox} in Outbox
        </button>
      )}
      {/* Paused rows are a subset of `pendingActions` — the rest of the queue is
          still draining — and outbox sends can never be auth-paused at all, so
          the reconnect control is its own readout rather than a relabeled count. */}
      {pausedActions > 0 && (
        <button
          type="button"
          data-testid="action-reconnect"
          onClick={onReconnect}
          data-tooltip="Google authorization expired; reconnect to retry paused changes"
          className="cursor-pointer font-medium text-accent hover:underline"
        >
          <span data-testid="paused-count">{pausedActions} paused</span> · Reconnect Google
        </button>
      )}
    </div>
  )
}

function AccountMenu({
  status,
  accountStatuses,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onOpenSettings,
  onOpenCheatSheet,
  accountActionsBlocked
}: {
  status: AuthStatus
  /** Live per-account health, pushed by the utility (F18). */
  accountStatuses: readonly AccountSyncStatus[] | null
  onSwitchAccount: (accountId: string) => void
  onAddAccount: () => void
  /** Opens the Remove-account confirmation for the active account (F18, D3). */
  onRemoveAccount: () => void
  onOpenSettings: () => void
  onOpenCheatSheet: () => void
  /** True while a composer is open: switching would drop unsaved keystrokes. */
  accountActionsBlocked: boolean
}): React.JSX.Element {
  const blockedTitle = accountActionsBlocked ? 'Save and close the draft first (Esc)' : undefined
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const { preference, setPreference } = useTheme()
  // The chip itself carries an attention mark while *any* account needs the
  // user, so a background failure is visible without opening the menu (F18).
  const { healthFor, needsAttention: chipAttention } = useAccountHealth(accountStatuses, open)

  const closeMenu = useCallback(() => {
    setOpen(false)
    blurActive()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeMenu, open])

  return (
    <div ref={wrapRef} data-testid="account-menu" className="app-no-drag relative">
      <button
        type="button"
        data-attention={chipAttention ? 'true' : undefined}
        className={`${CHIP_CLASS} flex cursor-pointer items-center gap-1.5 hover:border-accent hover:text-ink-dim`}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {chipAttention && (
          <span
            aria-hidden
            data-tooltip="An account needs attention"
            className="size-1.5 flex-none rounded-full bg-accent"
          />
        )}
        {status.email ?? 'signed in'} <span className="text-[8px]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-2 w-[250px] rounded-lg border border-edge bg-raised p-1.5 shadow-menu"
        >
          {status.accounts.map((account, index) => {
            const active = account.id === status.activeAccountId
            const health = healthFor(account.id)
            const attention = accountNeedsAttention(health)
            return (
              <button
                key={account.id}
                type="button"
                data-testid="account-switch"
                data-email={account.id}
                data-active={active ? 'true' : 'false'}
                disabled={accountActionsBlocked && !active}
                data-tooltip={active ? undefined : blockedTitle}
                onClick={() => {
                  closeMenu()
                  if (!active) onSwitchAccount(account.id)
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent ${
                  active ? 'text-ink' : 'text-ink-dim'
                }`}
              >
                <span className="flex min-w-0 flex-col items-start">
                  <span className="w-full truncate text-left">{account.email}</span>
                  {health && (
                    <AccountHealthLine health={health} attention={attention} testId="account-status" />
                  )}
                </span>
                <span className="flex flex-none items-center gap-1.5">
                  {active && (
                    <span aria-hidden className="text-accent">
                      ✓
                    </span>
                  )}
                  {index < 9 && status.accounts.length > 1 && <Kbd>{`${modKeyLabel()}${index + 1}`}</Kbd>}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            data-testid="account-add"
            disabled={accountActionsBlocked}
            data-tooltip={blockedTitle}
            onClick={() => {
              closeMenu()
              onAddAccount()
            }}
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
          >
            Add account…
          </button>
          <hr className="my-1.5 border-edge" />
          <div className="px-2.5">
            <PalettePicker />
          </div>
          <label className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim">
            <span>Appearance</span>
            <select
              data-testid="theme-picker"
              aria-label="Theme"
              value={preference}
              onChange={(event) => setPreference(event.target.value as ThemePreference)}
              className="min-w-0 cursor-pointer rounded-md border border-edge bg-ground px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            >
              {THEME_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="account-settings"
            // The composer guard other account actions honor: Settings hides
            // the content column while the composer's global key handlers stay
            // live, so opening it mid-draft lets keystrokes reach a surface
            // the user can no longer see (PR #101 review).
            disabled={accountActionsBlocked}
            data-tooltip={blockedTitle}
            onClick={() => {
              closeMenu()
              onOpenSettings()
            }}
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
          >
            Settings <Kbd>{`${modKeyLabel()} ,`}</Kbd>
          </button>
          <button
            type="button"
            data-testid="account-cheat-sheet"
            onClick={() => {
              closeMenu()
              onOpenCheatSheet()
            }}
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink"
          >
            Keyboard shortcuts <Kbd>{`${modKeyLabel()} /`}</Kbd>
          </button>
          <hr className="my-1.5 border-edge" />
          <button
            type="button"
            data-testid="account-remove"
            disabled={accountActionsBlocked}
            onClick={() => {
              closeMenu()
              onRemoveAccount()
            }}
            data-tooltip={
              blockedTitle ??
              "Removes this account's sign-in and stops its sync; you choose what happens to its local mail"
            }
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

interface MailHeaderProps {
  syncStatus: React.ReactNode
  pendingActionCount: number
  pausedActionCount: number
  outboxCount: number
  selectionCount: number
  composerOpen: boolean
  footerCollapsed: boolean
  onToggleFooter: () => void
  sidebarCollapsed: boolean
  status: AuthStatus
  accountStatuses: readonly AccountSyncStatus[] | null
  onReconnectActions: () => void
  onOpenOutbox: () => void
  onToggleSidebar: () => void
  onWrite: () => void
  writeDisabled: boolean
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
    footerCollapsed,
    onToggleFooter,
    sidebarCollapsed,
    status,
    accountStatuses,
    onReconnectActions,
    onOpenOutbox,
    onToggleSidebar,
    onWrite,
    writeDisabled,
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
      className="app-mail-header app-drag app-titlebar-safe-area flex flex-none items-center"
    >
      {!composerOpen && (
        <>
          <button
            type="button"
            data-testid="sidebar-toggle"
            data-state={sidebarCollapsed ? 'collapsed' : 'expanded'}
            aria-label={sidebarAction}
            aria-keyshortcuts={isMacPlatform() ? 'Meta+B' : 'Control+B'}
            aria-controls="mail-sidebar"
            aria-expanded={!sidebarCollapsed}
            data-tooltip={`${sidebarAction} (${sidebarShortcut})`}
            onClick={(event) => {
              onToggleSidebar()
              event.currentTarget.blur()
            }}
            className="app-no-drag flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[18px] fill-none stroke-current">
              <rect x="3" y="4" width="18" height="16" rx="2.5" strokeWidth="1.75" />
              <path d="M8.5 4v16" strokeWidth="1.75" />
            </svg>
          </button>
          <button
            type="button"
            data-testid="footer-toggle"
            aria-label={footerCollapsed ? 'Show keyboard hints' : 'Hide keyboard hints'}
            data-tooltip={`${footerCollapsed ? 'Show keyboard hints' : 'Hide keyboard hints'} (${modKeyLabel()}⇧B)`}
            aria-keyshortcuts={isMacPlatform() ? 'Meta+Shift+B' : 'Control+Shift+B'}
            aria-expanded={!footerCollapsed}
            aria-controls="mail-footer"
            onClick={(event) => {
              onToggleFooter()
              event.currentTarget.blur()
            }}
            className="app-no-drag flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <MailIcon name="keyboard" />
          </button>
        </>
      )}
      {composerOpen && <span aria-hidden className="w-16 flex-none" />}
      <Button
        data-testid="write-button"
        className="app-no-drag app-write"
        onClick={onWrite}
        disabled={writeDisabled}
        data-tooltip="Write (C)"
      >
        <MailIcon name="write" />
        Write
      </Button>
      <div className="app-no-drag ml-auto flex items-center gap-4">
        {!composerOpen && selectionCount > 0 && (
          <span
            data-testid="selection-count"
            className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent tabular-nums"
          >
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
        {props.syncStatus}
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
