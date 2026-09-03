import { ACCOUNT_SYNC_PHASE_LABELS, type AccountSyncStatus } from '../../../shared/auth'

/**
 * One account's sync phase and unread count, as the account menu and the
 * settings roster both render it: a phase label, the unread tail when there is
 * one, and the accent treatment when the account needs the user (F18).
 */
export function AccountHealthLine({
  health,
  attention,
  testId
}: {
  health: AccountSyncStatus
  attention: boolean
  testId: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      data-phase={health.phase}
      className={`text-[11px] ${attention ? 'font-medium text-accent' : 'text-ink-faint'}`}
    >
      {ACCOUNT_SYNC_PHASE_LABELS[health.phase]}
      {health.unread > 0 ? ` · ${health.unread} unread` : ''}
    </span>
  )
}
