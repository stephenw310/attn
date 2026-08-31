import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_SYNC_PHASE_LABELS, type AccountSyncStatus, type AuthStatus } from '../../../shared/auth'
import { oneHourFrom, tomorrowStart } from '../../../shared/notifications'
import { ALLOWED_UNDO_SEND_SECONDS, DEFAULT_UNDO_SEND_SECONDS } from '../../../shared/outboxTuning'
import {
  type AppSettingKey,
  type AppSettings,
  AUTO_ADVANCE_DIRECTIONS,
  AUTO_ADVANCE_LABELS,
  isAutoAdvanceDirection
} from '../../../shared/settings'
import { formatSnoozeDate } from '../../../shared/snooze'
import { THEME_OPTIONS, type ThemePreference } from '../../../shared/theme'
import { isMacPlatform, modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { Kbd } from './Kbd'

/** A control the palette can deep-link to (`Set undo send delay…` etc.). */
export type SettingsControl = 'accounts' | 'undoSendDelay' | 'autoAdvance' | 'launchAtLogin' | 'menuBarIcon'

interface SettingsViewProps {
  status: AuthStatus
  /** Live per-account health, pushed by the utility (F18). */
  accountStatuses: readonly AccountSyncStatus[] | null
  settings: AppSettings | null
  onUpdateSetting: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => void
  onStatus: (status: AuthStatus) => void
  onAddAccount: () => void
  onReconnect: () => void
  onSignOut: () => void
  onManageSplits: () => void
  onClose: () => void
  onToast: (message: string) => void
  focusControl: SettingsControl | null
}

const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint'
const ROW = 'flex items-center justify-between gap-4 rounded-md px-3 py-2'
const SELECT =
  'min-w-0 cursor-pointer rounded-md border border-edge bg-ground px-2 py-1 text-xs text-ink outline-none focus:border-accent'
const NOTE = 'text-[11px] leading-relaxed text-ink-faint'
const ACTION_BUTTON =
  'cursor-pointer rounded-md border border-edge px-2.5 py-1 text-xs text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'

const UNDO_SEND_CHOICES = [...ALLOWED_UNDO_SEND_SECONDS].sort((left, right) => left - right)

function undoSendLabel(seconds: number): string {
  if (seconds === 0) return 'Off — send immediately'
  const label = `${seconds} seconds`
  return seconds === DEFAULT_UNDO_SEND_SECONDS ? `${label} (default)` : label
}

export function SettingsView({
  status,
  accountStatuses,
  settings,
  onUpdateSetting,
  onStatus,
  onAddAccount,
  onReconnect,
  onSignOut,
  onManageSplits,
  onClose,
  onToast,
  focusControl
}: SettingsViewProps): React.JSX.Element {
  const { preference, setPreference } = useTheme()
  const [reorderPending, setReorderPending] = useState(false)
  const [openedStatuses, setOpenedStatuses] = useState<{
    statuses: AccountSyncStatus[]
    source: readonly AccountSyncStatus[] | null
  } | null>(null)
  const pushedStatusesRef = useRef(accountStatuses)
  pushedStatusesRef.current = accountStatuses
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeEmail = status.email ?? status.activeAccountId ?? null

  // The pushed statuses move only on phase changes; their unread counts can
  // lag, so the opened view re-reads once. A later push supersedes it — the
  // same contract the account menu keeps (F18).
  useEffect(() => {
    if (!window.attn) return
    let stale = false
    const source = pushedStatusesRef.current
    window.attn.auth
      .getAccountStatuses()
      .then((statuses) => {
        if (!stale) setOpenedStatuses({ statuses, source })
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  useEffect(() => {
    if (!focusControl) return
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-settings-control="${focusControl}"]`)
    target?.scrollIntoView({ block: 'center' })
    target?.focus({ preventScroll: true })
  }, [focusControl])

  const healthById = new Map(
    [
      ...(accountStatuses ?? []),
      ...(openedStatuses?.source === accountStatuses ? openedStatuses.statuses : [])
    ].map((health) => [health.accountId, health])
  )

  const moveAccount = useCallback(
    (index: number, delta: -1 | 1) => {
      const bridge = window.attn
      if (!bridge || reorderPending) return
      const ids = status.accounts.map((account) => account.id)
      const target = index + delta
      if (target < 0 || target >= ids.length) return
      const reordered = [...ids]
      ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
      setReorderPending(true)
      bridge.auth
        .reorderAccounts(reordered)
        .then(onStatus)
        .catch(() => onToast('Could not reorder accounts'))
        .finally(() => setReorderPending(false))
    },
    [onStatus, onToast, reorderPending, status.accounts]
  )

  const pausedUntil = settings?.notificationsPausedUntil ?? null
  const paused = pausedUntil !== null && pausedUntil > Date.now()

  return (
    <div ref={rootRef} data-testid="settings-view" className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-[44px] flex-none items-center gap-3 border-b border-edge pr-7 pl-[53px]">
        <button
          type="button"
          data-testid="settings-back"
          onClick={onClose}
          className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-ink"
        >
          <span aria-hidden>←</span> Back
        </button>
        <h1 className="text-base font-semibold text-ink">Settings</h1>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
          <Kbd>Esc</Kbd> closes
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-9 px-7 py-7">
          <section data-testid="settings-accounts" aria-label="Accounts">
            <h2 className={SECTION_TITLE}>Accounts</h2>
            <p className={`mt-1.5 ${NOTE}`}>
              The order below is the switcher order — {modKeyLabel()}1…9 follow it, and so does the account
              menu.
            </p>
            <div className="mt-2 flex flex-col">
              {status.accounts.map((account, index) => {
                const active = account.id === status.activeAccountId
                const health = healthById.get(account.id) ?? null
                const attention = health?.phase === 'reconnect' || health?.phase === 'error'
                return (
                  <div
                    key={account.id}
                    data-testid="settings-account-row"
                    data-email={account.id}
                    data-active={active ? 'true' : 'false'}
                    className={`${ROW} border-b border-edge/60 last:border-b-0`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 truncate text-[13px] text-ink">
                        {account.email}
                        {active && (
                          <span aria-hidden className="text-accent">
                            ✓
                          </span>
                        )}
                      </span>
                      {health && (
                        <span
                          data-testid="settings-account-status"
                          data-phase={health.phase}
                          className={`text-[11px] ${attention ? 'font-medium text-accent' : 'text-ink-faint'}`}
                        >
                          {ACCOUNT_SYNC_PHASE_LABELS[health.phase]}
                          {health.unread > 0 ? ` · ${health.unread} unread` : ''}
                        </span>
                      )}
                    </span>
                    <span className="flex flex-none items-center gap-1.5">
                      {attention && (
                        <button
                          type="button"
                          data-testid="settings-account-reconnect"
                          onClick={onReconnect}
                          className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-active"
                        >
                          Reconnect
                        </button>
                      )}
                      {index < 9 && status.accounts.length > 1 && <Kbd>{`${modKeyLabel()}${index + 1}`}</Kbd>}
                      <button
                        type="button"
                        data-testid="settings-account-up"
                        aria-label={`Move ${account.email} up`}
                        disabled={reorderPending || index === 0}
                        data-settings-control={index === 0 ? 'accounts' : undefined}
                        onClick={() => moveAccount(index, -1)}
                        className={ACTION_BUTTON}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        data-testid="settings-account-down"
                        aria-label={`Move ${account.email} down`}
                        disabled={reorderPending || index === status.accounts.length - 1}
                        onClick={() => moveAccount(index, 1)}
                        className={ACTION_BUTTON}
                      >
                        ↓
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                data-testid="settings-add-account"
                onClick={onAddAccount}
                className={ACTION_BUTTON}
              >
                Add account…
              </button>
              {activeEmail && (
                <button
                  type="button"
                  data-testid="settings-sign-out"
                  onClick={onSignOut}
                  title="Removes this account's sign-in and stops its sync; you choose what happens to its local mail"
                  className={ACTION_BUTTON}
                >
                  Sign out {activeEmail}…
                </button>
              )}
            </div>
          </section>

          <section data-testid="settings-triage" aria-label="Triage">
            <h2 className={SECTION_TITLE}>Triage</h2>
            <label className={`mt-2 ${ROW}`}>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">Undo send delay</span>
                <span className={NOTE}>How long a sent message can still be pulled back.</span>
              </span>
              <select
                data-testid="settings-undo-send-delay"
                data-settings-control="undoSendDelay"
                aria-label="Undo send delay"
                disabled={!settings}
                value={settings?.undoSendDelaySeconds ?? DEFAULT_UNDO_SEND_SECONDS}
                onChange={(event) => {
                  const seconds = Number(event.target.value)
                  if (ALLOWED_UNDO_SEND_SECONDS.has(seconds)) onUpdateSetting('undoSendDelaySeconds', seconds)
                }}
                className={SELECT}
              >
                {UNDO_SEND_CHOICES.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {undoSendLabel(seconds)}
                  </option>
                ))}
              </select>
            </label>
            <label className={ROW}>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">After done, snooze, or trash</span>
                <span className={NOTE}>Where the selection (and open reader) lands (auto-advance).</span>
              </span>
              <select
                data-testid="settings-auto-advance"
                data-settings-control="autoAdvance"
                aria-label="Auto-advance direction"
                disabled={!settings}
                value={settings?.autoAdvanceDirection ?? 'next'}
                onChange={(event) => {
                  if (isAutoAdvanceDirection(event.target.value)) {
                    onUpdateSetting('autoAdvanceDirection', event.target.value)
                  }
                }}
                className={SELECT}
              >
                {AUTO_ADVANCE_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {AUTO_ADVANCE_LABELS[direction]}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section data-testid="settings-notifications" aria-label="Notifications">
            <h2 className={SECTION_TITLE}>Notifications</h2>
            <div className={`mt-2 ${ROW}`}>
              <span className="flex min-w-0 flex-col">
                <span data-testid="settings-pause-state" className="text-[13px] text-ink">
                  {paused ? `Paused until ${formatSnoozeDate(pausedUntil)}` : 'Notifications are on'}
                </span>
                <span className={NOTE}>The pause covers every signed-in account.</span>
              </span>
              <span className="flex flex-none items-center gap-1.5">
                <button
                  type="button"
                  data-testid="settings-pause-hour"
                  disabled={!settings}
                  onClick={() => onUpdateSetting('notificationsPausedUntil', oneHourFrom())}
                  className={ACTION_BUTTON}
                >
                  Pause 1 hour
                </button>
                <button
                  type="button"
                  data-testid="settings-pause-tomorrow"
                  disabled={!settings}
                  onClick={() => onUpdateSetting('notificationsPausedUntil', tomorrowStart())}
                  className={ACTION_BUTTON}
                >
                  Until tomorrow
                </button>
                {paused && (
                  <button
                    type="button"
                    data-testid="settings-pause-resume"
                    onClick={() => onUpdateSetting('notificationsPausedUntil', null)}
                    className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-active"
                  >
                    Resume
                  </button>
                )}
              </span>
            </div>
            <div className={ROW}>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">Per-split new-mail alerts</span>
                <span className={NOTE}>
                  Which Inbox splits notify is a per-account choice{activeEmail ? ` for ${activeEmail}` : ''}{' '}
                  — manage it with the split rules.
                </span>
              </span>
              <button
                type="button"
                data-testid="settings-split-rules"
                onClick={onManageSplits}
                className={ACTION_BUTTON}
              >
                Split rules…
              </button>
            </div>
          </section>

          <section data-testid="settings-background" aria-label="Background">
            <h2 className={SECTION_TITLE}>Background</h2>
            <label className={`mt-2 ${ROW}`}>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">Launch at login</span>
                <span className={NOTE}>
                  Starts Attn in the background so snoozes, polling, and notifications keep working (F16). An
                  OS-side disable is respected until you change this again.
                </span>
              </span>
              <input
                type="checkbox"
                data-testid="settings-launch-at-login"
                data-settings-control="launchAtLogin"
                aria-label="Launch at login"
                disabled={!settings}
                checked={settings?.launchAtLogin ?? true}
                onChange={(event) => onUpdateSetting('launchAtLogin', event.target.checked)}
                className="size-4 cursor-pointer accent-accent"
              />
            </label>
            {isMacPlatform() && (
              <label className={ROW}>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] text-ink">Menu-bar icon</span>
                  <span className={NOTE}>
                    An optional menu-bar icon mirroring the tray menu (default off).
                  </span>
                </span>
                <input
                  type="checkbox"
                  data-testid="settings-menu-bar-icon"
                  data-settings-control="menuBarIcon"
                  aria-label="macOS menu-bar icon"
                  disabled={!settings}
                  checked={settings?.menuBarIcon ?? false}
                  onChange={(event) => onUpdateSetting('menuBarIcon', event.target.checked)}
                  className="size-4 cursor-pointer accent-accent"
                />
              </label>
            )}
          </section>

          <section data-testid="settings-appearance" aria-label="Appearance">
            <h2 className={SECTION_TITLE}>Appearance</h2>
            <label className={`mt-2 ${ROW}`}>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] text-ink">Theme</span>
                <span className={NOTE}>System follows the OS; a named palette pins it (F14).</span>
              </span>
              <select
                data-testid="settings-theme"
                aria-label="Theme"
                value={preference}
                onChange={(event) => setPreference(event.target.value as ThemePreference)}
                className={SELECT}
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </div>
      </div>
    </div>
  )
}
