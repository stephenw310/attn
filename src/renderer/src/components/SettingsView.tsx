import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_SYNC_PHASE_LABELS, type AccountSyncStatus, type AuthStatus } from '../../../shared/auth'
import { oneHourFrom, tomorrowStart } from '../../../shared/notifications'
import { ALLOWED_UNDO_SEND_SECONDS, DEFAULT_UNDO_SEND_SECONDS } from '../../../shared/outboxTuning'
import {
  type AccountSettingKey,
  type AccountSettings,
  type AppSettingKey,
  type AppSettings,
  ATTN_SIGNATURE_LINE,
  AUTO_ADVANCE_DIRECTIONS,
  AUTO_ADVANCE_LABELS,
  DEFAULT_LIFETIME_THREAD_CAP,
  isAutoAdvanceDirection,
  LIFETIME_THREAD_CAP_ALL_MAIL
} from '../../../shared/settings'
import { formatSnoozeDate } from '../../../shared/snooze'
import { THEME_OPTIONS, type ThemePreference } from '../../../shared/theme'
import { isMacPlatform, modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { AiSettingsSection } from './AiSettingsSection'
import { Kbd } from './Kbd'
import { SnippetManager } from './SnippetManager'

/** A control the palette can deep-link to (`Set undo send delay…` etc.). */
export type SettingsControl =
  | 'accounts'
  | 'syncLimit'
  | 'undoSendDelay'
  | 'autoAdvance'
  | 'attnFooter'
  | 'snippets'
  | 'aiWriting'
  | 'remoteImages'
  | 'launchAtLogin'
  | 'menuBarIcon'

type SyncLimitMode = 'default' | 'custom' | 'all'

interface SettingsViewProps {
  status: AuthStatus
  /** Live per-account health, pushed by the utility (F18). */
  accountStatuses: readonly AccountSyncStatus[] | null
  settings: AppSettings | null
  /** The active account's scoped settings; null until its read lands (F18). */
  accountSettings: AccountSettings | null
  onUpdateSetting: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => void
  onUpdateAccountSetting: <K extends AccountSettingKey>(key: K, value: AccountSettings[K]) => void
  /**
   * Runs the reorder round trip above the keyed account remount (see App):
   * the owner adopts only the ordering, restricted to the live roster, and
   * rejects a response a newer reorder has superseded — a reorder never
   * changes the active account, so a raced switch is never rolled back.
   */
  onReorderAccounts: (ids: string[]) => Promise<void>
  onAddAccount: () => void
  onReconnect: () => void
  onSignOut: () => void
  onClose: () => void
  onToast: (message: string) => void
  focusControl: SettingsControl | null
}

const SECTION_TITLE = 'text-sm font-semibold text-ink'
const ROW = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 rounded-md px-3 py-2.5'
const SELECT =
  'min-w-0 max-w-[min(21rem,45vw)] cursor-pointer rounded-md border border-edge bg-ground px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'
const NOTE = 'text-[13px] leading-[1.55] text-ink-dim'
const ACTION_BUTTON =
  'cursor-pointer whitespace-nowrap rounded-md border border-edge px-2.5 py-1.5 text-sm text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className={SECTION_TITLE}>{children}</h3>
}

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
  accountSettings,
  onUpdateSetting,
  onUpdateAccountSetting,
  onReorderAccounts,
  onAddAccount,
  onReconnect,
  onSignOut,
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
      if (reorderPending) return
      const ids = status.accounts.map((account) => account.id)
      const target = index + delta
      if (target < 0 || target >= ids.length) return
      const reordered = [...ids]
      ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
      setReorderPending(true)
      onReorderAccounts(reordered)
        .catch(() => onToast('Could not reorder accounts'))
        .finally(() => setReorderPending(false))
    },
    [onReorderAccounts, onToast, reorderPending, status.accounts]
  )

  const pausedUntil = settings?.notificationsPausedUntil ?? null
  const paused = pausedUntil !== null && pausedUntil > Date.now()

  // Remote-image overrides (T33): app-global rows the section lists and can
  // remove. Loaded on open; each removal returns the fresh list.
  const [remoteOverrides, setRemoteOverrides] = useState<string[] | null>(null)
  useEffect(() => {
    if (!window.attn) return
    let stale = false
    window.attn.mail
      .listRemoteImageOverrides()
      .then((overrides) => {
        if (!stale) setRemoteOverrides(overrides)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  const removeRemoteOverride = useCallback(
    (address: string) => {
      void window.attn?.mail
        .removeRemoteImageOverride(address)
        .then(setRemoteOverrides)
        .catch(() => onToast('Override could not be removed'))
    },
    [onToast]
  )

  // Historical sync limit (T32A). The stored override decides the resting
  // mode; a draft carries an in-progress choice (custom typing, the All-mail
  // confirmation) without writing anything until it is applied.
  const storedCap = accountSettings?.lifetimeThreadCap ?? null
  const storedLimitMode: SyncLimitMode =
    storedCap === null ? 'default' : storedCap === LIFETIME_THREAD_CAP_ALL_MAIL ? 'all' : 'custom'
  const [limitDraft, setLimitDraft] = useState<{ mode: SyncLimitMode; custom: string } | null>(null)
  const limitMode = limitDraft?.mode ?? storedLimitMode
  const customLimitValue =
    limitDraft?.custom ??
    String(storedCap !== null && storedCap > 0 ? storedCap : DEFAULT_LIFETIME_THREAD_CAP)
  const parsedCustomLimit = Number(customLimitValue)
  const customLimitValid = Number.isSafeInteger(parsedCustomLimit) && parsedCustomLimit > 0
  const customLimitDirty = limitDraft !== null && String(storedCap ?? '') !== customLimitValue
  const confirmAllMail = limitMode === 'all' && storedLimitMode !== 'all'
  const changeLimitMode = (next: string): void => {
    if (next === 'default') {
      setLimitDraft(null)
      if (storedLimitMode !== 'default') onUpdateAccountSetting('lifetimeThreadCap', null)
    } else if (next === 'custom' || next === 'all') {
      setLimitDraft({ mode: next, custom: customLimitValue })
    }
  }

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
        <div className="mx-auto flex w-full max-w-[840px] flex-col gap-8 px-7 py-7">
          <section data-testid="settings-accounts" aria-label="Accounts">
            <h2 className="text-lg font-semibold text-ink">Accounts</h2>
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
                      <span className="flex items-center gap-2 truncate text-sm text-ink">
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

          <section
            data-testid="settings-account-scope"
            aria-label={`Settings for ${activeEmail ?? 'this account'}`}
            className="rounded-xl border border-edge bg-ground/45 p-4"
          >
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-ink">This account</h2>
              <p className={`mt-1 ${NOTE}`}>
                These settings apply only to {activeEmail ?? 'the active account'}.
              </p>
            </div>
            <div className="flex flex-col gap-7">
              <section data-testid="settings-sync" aria-label="Sync and storage">
                <SectionTitle>Sync &amp; storage</SectionTitle>
                <div className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Stored email history</span>
                    <span data-testid="settings-sync-description" className={NOTE}>
                      Attn stores up to this many email threads for this account. A thread is one conversation
                      and can contain several individual messages. Inbox sync, new mail, Gmail search, and
                      threads you open can still add mail; lowering this limit does not delete stored mail.
                    </span>
                  </span>
                  <select
                    data-testid="settings-sync-limit-mode"
                    data-settings-control="syncLimit"
                    aria-label="Stored email history"
                    disabled={!accountSettings}
                    value={limitMode}
                    onChange={(event) => changeLimitMode(event.target.value)}
                    className={SELECT}
                  >
                    <option value="default">
                      Recommended — {DEFAULT_LIFETIME_THREAD_CAP.toLocaleString()} email threads
                    </option>
                    <option value="custom">Custom…</option>
                    <option value="all">All mail</option>
                  </select>
                </div>
                {limitMode === 'custom' && (
                  <div className={ROW}>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm text-ink">Custom limit (email threads)</span>
                      <span className={NOTE}>A positive whole number of threads to keep stored.</span>
                    </span>
                    <span className="flex flex-none items-center gap-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        data-testid="settings-sync-limit-custom"
                        aria-label="Custom stored email history limit"
                        value={customLimitValue}
                        onChange={(event) => setLimitDraft({ mode: 'custom', custom: event.target.value })}
                        className="w-32 rounded-md border border-edge bg-ground px-2.5 py-1.5 text-right text-sm text-ink tabular-nums outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        data-testid="settings-sync-limit-apply"
                        disabled={!customLimitValid || !customLimitDirty}
                        onClick={() => {
                          if (!customLimitValid) return
                          setLimitDraft(null)
                          onUpdateAccountSetting('lifetimeThreadCap', parsedCustomLimit)
                        }}
                        className={ACTION_BUTTON}
                      >
                        Apply
                      </button>
                    </span>
                  </div>
                )}
                {confirmAllMail && (
                  <div
                    data-testid="settings-sync-limit-confirm"
                    className="mx-3 mt-1 rounded-md border border-accent/40 bg-accent/10 px-3 py-2"
                  >
                    <p className="text-[12px] leading-relaxed text-ink-dim">
                      Sync all mail for {activeEmail ?? 'this account'}? A large account can require
                      substantial disk space, Gmail API quota, and time with the app open before indexing
                      completes.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="settings-sync-limit-confirm-apply"
                        onClick={() => {
                          setLimitDraft(null)
                          onUpdateAccountSetting('lifetimeThreadCap', LIFETIME_THREAD_CAP_ALL_MAIL)
                        }}
                        className="cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20"
                      >
                        Sync all mail
                      </button>
                      <button
                        type="button"
                        data-testid="settings-sync-limit-cancel"
                        onClick={() => setLimitDraft(null)}
                        className={ACTION_BUTTON}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section data-testid="settings-compose" aria-label="Compose">
                <SectionTitle>Compose</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Include “{ATTN_SIGNATURE_LINE}”</span>
                    <span className={NOTE}>
                      Adds the line{' '}
                      <span data-testid="settings-attn-signature-preview" className="text-ink-dim">
                        {ATTN_SIGNATURE_LINE}
                      </span>{' '}
                      after your Gmail signature in new drafts only. “Attn:” links to the project on GitHub.
                      The line stays editable and removable, and changing this never touches open, saved, or
                      queued drafts.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="settings-attn-signature"
                    data-settings-control="attnFooter"
                    aria-label="Include Sent with Attn"
                    disabled={!accountSettings}
                    checked={accountSettings?.attnSignatureEnabled ?? true}
                    onChange={(event) => onUpdateAccountSetting('attnSignatureEnabled', event.target.checked)}
                    className="size-4 cursor-pointer accent-accent"
                  />
                </label>
              </section>
            </div>
          </section>

          <section
            data-testid="settings-all-accounts-scope"
            aria-label="Settings for all accounts"
            className="rounded-xl border border-edge bg-ground/45 p-4"
          >
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-ink">All accounts</h2>
              <p className={`mt-1 ${NOTE}`}>These settings apply to every signed-in account and mailbox.</p>
            </div>
            <div className="flex flex-col gap-7">
              <section data-testid="settings-triage" aria-label="Triage">
                <SectionTitle>Triage</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Undo send delay</span>
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
                      if (ALLOWED_UNDO_SEND_SECONDS.has(seconds))
                        onUpdateSetting('undoSendDelaySeconds', seconds)
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
                    <span className="text-sm text-ink">After done, snooze, or trash</span>
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

              <section data-testid="settings-ai" aria-label="AI writing">
                <SectionTitle>AI writing</SectionTitle>
                <AiSettingsSection onToast={onToast} />
              </section>

              <section data-testid="settings-snippets" aria-label="Snippets">
                <SectionTitle>Snippets</SectionTitle>
                <div className="mt-2">
                  <SnippetManager onToast={onToast} />
                </div>
              </section>

              <section data-testid="settings-notifications" aria-label="Notifications">
                <SectionTitle>Notifications</SectionTitle>
                <div className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span data-testid="settings-pause-state" className="text-sm text-ink">
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
              </section>

              <section data-testid="settings-security" aria-label="Security">
                <SectionTitle>Security</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Block remote images</span>
                    <span data-testid="settings-remote-images-description" className={NOTE}>
                      Applies to every mailbox and signed-in account. Remote images can reveal your address
                      and read time to a sender. Blocking hides them in messages and quoted replies; each
                      message offers Load once or a per-sender exception.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="settings-remote-images"
                    data-settings-control="remoteImages"
                    aria-label="Block remote images"
                    disabled={!settings}
                    checked={settings?.remoteImagesBlocked ?? false}
                    onChange={(event) => onUpdateSetting('remoteImagesBlocked', event.target.checked)}
                    className="size-4 cursor-pointer accent-accent"
                  />
                </label>
                {remoteOverrides !== null && remoteOverrides.length > 0 && (
                  <div className="mt-1 flex flex-col">
                    <p className={`px-3 ${NOTE}`}>Senders whose images always load:</p>
                    {remoteOverrides.map((address) => (
                      <div
                        key={address}
                        data-testid="settings-remote-image-override"
                        data-address={address}
                        className={`${ROW} border-b border-edge/60 last:border-b-0`}
                      >
                        <span className="truncate text-sm text-ink-dim">{address}</span>
                        <button
                          type="button"
                          data-testid="settings-remote-image-override-remove"
                          onClick={() => removeRemoteOverride(address)}
                          className={ACTION_BUTTON}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section data-testid="settings-background" aria-label="Background">
                <SectionTitle>Background</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Launch at login</span>
                    <span className={NOTE}>
                      Starts Attn in the background so snoozes, polling, and notifications keep working. An
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
                      <span className="text-sm text-ink">Menu-bar icon</span>
                      <span className={NOTE}>
                        Shows a compact Attn icon for opening the app and managing notification pauses.
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
                <SectionTitle>Appearance</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Theme</span>
                    <span className={NOTE}>System follows the OS; a named palette pins it.</span>
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
          </section>
        </div>
      </div>
    </div>
  )
}
