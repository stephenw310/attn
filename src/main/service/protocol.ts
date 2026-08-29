import type { RevertedAction } from '../../shared/actionRevert'
import type { InvokeChannel, MailChangeReason } from '../../shared/ipc'
import type { OAuthConfig, TokenSet } from '../auth/googleAuth'
import type { NotificationCandidate } from './notificationQueries'

export const SERVICE_PROTOCOL_VERSION = 3

/** One signed-in account's credentials as main relays them to the utility. */
export interface ServiceAccountAuth {
  /** Normalized email — the account id used across the store (F18). */
  id: string
  tokens: TokenSet
  /** Per-account auth generation; bumped by each interactive sign-in of this account. */
  generation: number
}

/**
 * The full authentication state, always sent whole: the roster in switcher
 * order plus the account the UI should render. Seeded e2e accounts are not in
 * `accounts` (they have no tokens); `seedAccountIds` names the survivors so a
 * seeded sign-out can retire a seed session. Omitted → keep current seeds.
 */
export interface ServiceAccountsState {
  config: OAuthConfig | null
  accounts: ServiceAccountAuth[]
  activeAccountId: string | null
  seedAccountIds?: string[]
}

export interface ServiceInitialize {
  protocolVersion: number
  dbPath: string
  userDataPath: string
  downloadsPath: string
  testMode: boolean
  testSeed?: string
  accounts: ServiceAccountsState
  focused: boolean
}

export type ServiceControl =
  | { kind: 'accounts'; accounts: ServiceAccountsState }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'resume' }
  | { kind: 'refresh-schedulers' }
  | { kind: 'stop' }

export type ServiceOperation =
  | 'resume-auth-failures'
  | 'apply-accounts'
  | 'set-active-account'
  | 'mark-login-item-registered'
  | 'set-notification-pause'
  | 'test'

export type MainToServiceMessage =
  | { type: 'initialize'; payload: ServiceInitialize }
  | { type: 'request'; id: number; channel: InvokeChannel; args: unknown[] }
  | { type: 'internal-request'; id: number; operation: ServiceOperation; args: unknown[] }
  | { type: 'control'; payload: ServiceControl }

export interface ServiceReady {
  /** Resolved active account (persisted choice when valid, else first in roster). */
  activeAccountId: string | null
  /** Every live session in switcher order, seeded accounts included. */
  accountIds: string[]
  schemaVersion: number
  background: {
    launchAtLogin: boolean
    loginItemRegistered: boolean
  }
}

export type ServiceEvent =
  | { kind: 'mail-changed'; serverSearchRequestId?: string; reason?: MailChangeReason }
  | { kind: 'outbox-changed'; payload: import('../../shared/outbox').OutboxChanged }
  | { kind: 'outbox-progress'; payload: import('../../shared/outbox').OutboxProgress | null }
  | { kind: 'sync-state'; payload: import('../../shared/mail').SyncState }
  | { kind: 'body-hydration-failed'; accountId: string; threadId: string }
  | { kind: 'actions-reverted'; accountId: string; actions: RevertedAction[] }
  | { kind: 'badge'; unreadCount: number }
  | {
      kind: 'notification-candidates'
      accountId: string
      candidates: NotificationCandidate[]
      pausedUntil: number | null
    }
  | { kind: 'token-update'; accountId: string; tokens: TokenSet; generation: number }
  | { kind: 'log'; level: 'log' | 'warn' | 'error'; message: string }

export type ServiceToMainMessage =
  | { type: 'ready'; payload: ServiceReady }
  | { type: 'response'; id: number; result: unknown }
  | { type: 'response-error'; id: number; message: string; stack?: string }
  | { type: 'event'; payload: ServiceEvent }
  | { type: 'test-result'; channel: string; result: unknown; error?: string }
  | { type: 'stopped' }

export function isMainToServiceMessage(value: unknown): value is MainToServiceMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'initialize' || type === 'request' || type === 'internal-request' || type === 'control'
}
