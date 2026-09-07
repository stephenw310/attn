import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSyncStatus, AuthStatus } from '../../../shared/auth'
import { THEME_OPTIONS, type ThemePreference } from '../../../shared/theme'
import { accountNeedsAttention, useAccountHealth } from '../hooks/useAccountHealth'
import { modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { AccountHealthLine } from './AccountHealthLine'
import { blurActive } from './blurActive'
import { Kbd } from './Kbd'

export function AccountMenu({
  status,
  accountStatuses,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onOpenSettings,
  onOpenCheatSheet,
  accountActionsBlocked,
  placement
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
  /** The sidebar writes the account at the foot of the page and opens the menu
      upward; the header carries it only while the sidebar is collapsed. */
  placement: 'sidebar' | 'header'
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
        className="app-no-drag flex w-full cursor-pointer items-center gap-2 px-1 py-1 text-left text-[14px] text-ink-faint hover:text-ink"
        onClick={() => (open ? closeMenu() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {chipAttention && (
          <span aria-hidden title="An account needs attention" className="size-[7px] flex-none bg-accent" />
        )}
        <span className="min-w-0 truncate">{status.email ?? 'signed in'}</span>
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute z-50 w-[280px] border border-edge bg-raised p-1.5 shadow-menu ${
            placement === 'sidebar' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'
          }`}
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
                title={active ? undefined : blockedTitle}
                onClick={() => {
                  closeMenu()
                  if (!active) onSwitchAccount(account.id)
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[13px] hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent ${
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
            title={blockedTitle}
            onClick={() => {
              closeMenu()
              onAddAccount()
            }}
            className="flex w-full cursor-pointer items-center justify-between px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
          >
            Add account…
          </button>
          <hr className="my-1.5 border-edge" />
          <label className="flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-[13px] text-ink-dim">
            <span>Theme</span>
            <select
              data-testid="theme-picker"
              aria-label="Theme"
              value={preference}
              onChange={(event) => setPreference(event.target.value as ThemePreference)}
              className="min-w-0 cursor-pointer border border-edge bg-ground px-2 py-1 text-xs text-ink outline-none focus:border-accent"
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
            title={blockedTitle}
            onClick={() => {
              closeMenu()
              onOpenSettings()
            }}
            className="flex w-full cursor-pointer items-center justify-between px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
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
            className="flex w-full cursor-pointer items-center justify-between px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink"
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
            title={
              blockedTitle ??
              "Removes this account's sign-in and stops its sync; you choose what happens to its local mail"
            }
            className="flex w-full cursor-pointer items-center justify-between px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
