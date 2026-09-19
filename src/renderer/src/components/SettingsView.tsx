import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountSyncStatus, AuthStatus } from '../../../shared/auth'
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
import { accountNeedsAttention, useAccountHealth } from '../hooks/useAccountHealth'
import { isMacPlatform, modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { useShowToast } from '../toastContext'
import { AboutSection } from './AboutSection'
import { AccountHealthLine } from './AccountHealthLine'
import { AiSettingsSection } from './AiSettingsSection'
import { Kbd } from './Kbd'
import { PalettePicker } from './PalettePicker'
import { SnippetManager } from './SnippetManager'
import { ACTION_BUTTON, NOTE, ROW, SECTION_TITLE, SELECT } from './settingsStyles'

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
  | 'unreadBadge'
  | 'launchAtLogin'
  | 'menuBarIcon'

const SETTINGS_PAGES = [
  { id: 'appearance', title: 'Appearance', scope: 'app' },
  { id: 'triage', title: 'Triage & sending', scope: 'app' },
  { id: 'notifications', title: 'Notifications', scope: 'app' },
  { id: 'security', title: 'Privacy', scope: 'app' },
  { id: 'background', title: 'Background', scope: 'app' },
  { id: 'ai', title: 'AI writing', scope: 'app' },
  { id: 'snippets', title: 'Snippets', scope: 'app' },
  { id: 'about', title: 'About', scope: 'app' },
  { id: 'sync', title: 'Sync & storage', scope: 'account' },
  { id: 'compose', title: 'Signature', scope: 'account' },
  { id: 'accounts', title: 'Accounts', scope: 'connections' }
] as const

type SettingsPage = (typeof SETTINGS_PAGES)[number]['id']
const CONTROL_PAGE: Record<SettingsControl, SettingsPage> = {
  accounts: 'accounts',
  syncLimit: 'sync',
  undoSendDelay: 'triage',
  autoAdvance: 'triage',
  attnFooter: 'compose',
  snippets: 'snippets',
  aiWriting: 'ai',
  remoteImages: 'security',
  unreadBadge: 'notifications',
  launchAtLogin: 'background',
  menuBarIcon: 'background'
}

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
  /** Opens the Split rules manager, which owns the smart-splits consent (F11). */
  onOpenSplits: () => void
  onClose: () => void
  onNavigate: () => void
  focusControl: SettingsControl | null
}

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
  onOpenSplits,
  onClose,
  focusControl,
  onNavigate
}: SettingsViewProps): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>(focusControl ? CONTROL_PAGE[focusControl] : 'appearance')
  const selectedPage = SETTINGS_PAGES.find((item) => item.id === page) ?? SETTINGS_PAGES[0]
  useEffect(() => {
    if (focusControl) setPage(CONTROL_PAGE[focusControl])
  }, [focusControl])
  const onToast = useShowToast()
  const { preference, setPreference } = useTheme()
  const [reorderPending, setReorderPending] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeEmail = status.email ?? status.activeAccountId ?? null

  const { healthFor } = useAccountHealth(accountStatuses, true)

  useEffect(() => {
    if (!focusControl || CONTROL_PAGE[focusControl] !== page) return
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-settings-control="${focusControl}"]`)
    target?.scrollIntoView({ block: 'center' })
    target?.focus({ preventScroll: true })
  }, [focusControl, page])

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
    <div
      ref={rootRef}
      data-testid="settings-view"
      className="app-settings mx-auto flex min-h-0 w-full max-w-[1060px] flex-1 flex-col px-5"
    >
      <div className="flex h-24 flex-none items-center gap-3">
        <h1 className="text-[21px] font-medium tracking-[-0.5px] text-ink">Settings</h1>
        <button
          type="button"
          data-testid="settings-back"
          aria-label="Close settings"
          data-tooltip="Close settings (Esc)"
          onClick={onClose}
          className="ml-auto cursor-pointer rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-ink"
        >
          Back to mail <Kbd>Esc</Kbd>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-[66px] pb-8 max-md:gap-5">
        <nav
          aria-label="Settings sections"
          className="app-navigation-focus w-[190px] shrink-0 overflow-y-auto max-md:w-36"
        >
          {(['app', 'account', 'connections'] as const).map((scope) => (
            <div key={scope} className="mb-8">
              <p className="mb-3 px-2.5 text-[10px] font-medium text-ink-dim">
                {scope === 'app'
                  ? 'All accounts'
                  : scope === 'account'
                    ? 'Current account'
                    : 'Connected accounts'}
                {scope === 'account' && (
                  <span className="mt-1 block truncate" title={activeEmail ?? undefined}>
                    {activeEmail}
                  </span>
                )}
              </p>
              {SETTINGS_PAGES.filter((item) => item.scope === scope).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  aria-current={page === item.id ? 'page' : undefined}
                  onClick={() => {
                    onNavigate()
                    setPage(item.id)
                  }}
                  className={`mb-1 block w-full rounded-md px-2.5 py-2.5 text-left text-xs ${page === item.id ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active/50'}`}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
          <section hidden={page !== 'accounts'} data-testid="settings-accounts" aria-label="Accounts">
            <h2 className={SECTION_TITLE}>Accounts</h2>
            <p className={`mt-1.5 ${NOTE}`}>
              The order here sets the account switcher order and {modKeyLabel()}1–9 shortcuts.
            </p>
            <div className="mt-2 flex flex-col">
              {status.accounts.map((account, index) => {
                const active = account.id === status.activeAccountId
                const health = healthFor(account.id)
                const attention = accountNeedsAttention(health)
                return (
                  <div
                    key={account.id}
                    data-testid="settings-account-row"
                    data-email={account.id}
                    data-active={active ? 'true' : 'false'}
                    className={`${ROW} border-b border-edge/60 last:border-b-0`}
                  >
                    <span className="flex min-w-0 items-center gap-[13px]">
                      <span
                        aria-hidden="true"
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-active text-xs text-ink-dim"
                      >
                        {account.email.slice(0, 2).toUpperCase()}
                      </span>
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
                          <AccountHealthLine
                            health={health}
                            attention={attention}
                            testId="settings-account-status"
                          />
                        )}
                      </span>
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
            hidden={selectedPage.scope !== 'account'}
            data-testid="settings-account-scope"
            aria-label={`Settings for ${activeEmail ?? 'this account'}`}
            className="min-w-0"
          >
            <div className="sr-only">
              <h2 className="text-lg font-semibold text-ink">This account</h2>
              <p className={`mt-1 ${NOTE}`}>
                These settings apply only to {activeEmail ?? 'the active account'}.
              </p>
            </div>
            <div className="flex flex-col gap-7">
              <section hidden={page !== 'sync'} data-testid="settings-sync" aria-label="Sync and storage">
                <SectionTitle>Sync &amp; storage</SectionTitle>
                <p className="mb-5 text-xs leading-[1.65] text-ink-dim">
                  These controls apply only to {activeEmail}. Your other accounts keep their own sync limits.
                </p>
                <div className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Stored email history</span>
                    <span data-testid="settings-sync-description" className={NOTE}>
                      Maximum email threads to store for this account.
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
                <p className="mt-[21px] text-[11px] leading-[1.6] text-ink-dim">
                  Changing the limit does not delete mail already stored. Inbox sync, new mail, Gmail search,
                  and threads you open can still add mail beyond this limit.
                </p>
              </section>

              <section hidden={page !== 'compose'} data-testid="settings-compose" aria-label="Compose">
                <SectionTitle>Signature</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Include “{ATTN_SIGNATURE_LINE}”</span>
                    <span className={NOTE}>
                      Append{' '}
                      <span data-testid="settings-attn-signature-preview" className="text-ink-dim">
                        {ATTN_SIGNATURE_LINE}
                      </span>{' '}
                      after this account’s Gmail signature in new drafts.
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
                    className="app-pref-toggle"
                  />
                </label>
                <p className="mt-[21px] text-[11px] leading-[1.6] text-ink-dim">
                  Saved drafts, open composers, and queued messages keep their existing content.
                </p>
              </section>
            </div>
          </section>

          <section
            hidden={selectedPage.scope !== 'app'}
            data-testid="settings-all-accounts-scope"
            aria-label="Settings for all accounts"
            className="min-w-0"
          >
            <div className="sr-only">
              <h2 className="text-lg font-semibold text-ink">All accounts</h2>
              <p className={`mt-1 ${NOTE}`}>These settings apply to every signed-in account and mailbox.</p>
            </div>
            <div className="flex flex-col gap-7">
              <section hidden={page !== 'triage'} data-testid="settings-triage" aria-label="Triage">
                <SectionTitle>Triage &amp; sending</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Undo send delay</span>
                    <span className={NOTE}>Time to cancel a message before it is sent.</span>
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
                    <span className={NOTE}>Where selection and the open reader move.</span>
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

              <section hidden={page !== 'ai'} data-testid="settings-ai" aria-label="AI writing">
                <SectionTitle>AI writing</SectionTitle>
                <AiSettingsSection />
              </section>

              <section hidden={page !== 'snippets'} data-testid="settings-snippets" aria-label="Snippets">
                <SectionTitle>Snippets</SectionTitle>
                <p className="mb-5 text-xs leading-[1.65] text-ink-dim">
                  One set of reusable snippets is available in every account.
                </p>
                <div className="mt-5">
                  <SnippetManager active={page === 'snippets'} />
                </div>
              </section>

              <section
                hidden={page !== 'notifications'}
                data-testid="settings-notifications"
                aria-label="Notifications"
              >
                <SectionTitle>Notifications</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Unread badge</span>
                    <span className={NOTE}>Show unread mail on the Dock or taskbar icon.</span>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="settings-unread-badge"
                    data-settings-control="unreadBadge"
                    aria-label="Unread app badge"
                    disabled={!settings}
                    checked={settings?.unreadBadgeEnabled ?? true}
                    onChange={(event) => onUpdateSetting('unreadBadgeEnabled', event.target.checked)}
                    className="app-pref-toggle"
                  />
                </label>
                <div className={ROW}>
                  <span className="flex min-w-0 flex-col">
                    <span data-testid="settings-pause-state" className="text-sm text-ink">
                      Pause notifications
                    </span>
                    <span className={NOTE}>
                      {paused
                        ? `Paused until ${formatSnoozeDate(pausedUntil)} across every account.`
                        : 'Notifications are active across every account.'}
                    </span>
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
                <h4 className="mb-2 mt-[29px] text-[15px] font-medium text-ink">Notification sources</h4>
                <p className="mb-3 text-xs leading-[1.65] text-ink-dim">
                  Each account chooses which Inbox splits send notifications.
                </p>
                <button type="button" onClick={onOpenSplits} className="py-2 text-xs text-accent">
                  Split rules for {activeEmail} ↗
                </button>
              </section>

              <section hidden={page !== 'security'} data-testid="settings-security" aria-label="Security">
                <SectionTitle>Privacy</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Block remote images</span>
                    <span data-testid="settings-remote-images-description" className={NOTE}>
                      Block sender-hosted images in mail from every account.
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
                    className="app-pref-toggle"
                  />
                </label>
                {remoteOverrides !== null && (
                  <div className="mt-1 flex flex-col">
                    <h4 className="mb-2 mt-[29px] text-[15px] font-medium text-ink">Always-load senders</h4>
                    <p className="mb-3 text-xs leading-[1.65] text-ink-dim">
                      Sender permissions are shared across accounts. You can allow a sender while reading
                      their message.
                    </p>
                    {remoteOverrides.length === 0 && (
                      <div className={`${ROW} mt-6 text-[11px] text-ink-dim`}>No sender exceptions.</div>
                    )}
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

              <section
                hidden={page !== 'background'}
                data-testid="settings-background"
                aria-label="Background"
              >
                <SectionTitle>Background</SectionTitle>
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Launch at login</span>
                    <span className={NOTE}>Start Attn when you sign in to your computer.</span>
                  </span>
                  <input
                    type="checkbox"
                    data-testid="settings-launch-at-login"
                    data-settings-control="launchAtLogin"
                    aria-label="Launch at login"
                    disabled={!settings}
                    checked={settings?.launchAtLogin ?? true}
                    onChange={(event) => onUpdateSetting('launchAtLogin', event.target.checked)}
                    className="app-pref-toggle"
                  />
                </label>
                {isMacPlatform() && (
                  <label className={ROW}>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm text-ink">Menu bar icon</span>
                      <span className={NOTE}>
                        Keep the icon visible while the window is open. It always appears when you close the
                        window.
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
                      className="app-pref-toggle"
                    />
                  </label>
                )}
              </section>

              <section
                hidden={page !== 'appearance'}
                data-testid="settings-appearance"
                aria-label="Appearance"
              >
                <SectionTitle>Appearance</SectionTitle>
                <p className="mb-5 text-xs leading-[1.65] text-ink-dim">
                  Choose a palette, then follow your system or choose a light or dark appearance.
                </p>
                <PalettePicker />
                <label className={`mt-2 ${ROW}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">Appearance</span>
                    <span className={NOTE}>System follows your device’s appearance.</span>
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

              <section hidden={page !== 'about'} data-testid="settings-about" aria-label="About">
                <SectionTitle>About</SectionTitle>
                <AboutSection />
              </section>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
