import type { RevertedAction } from '../../shared/actionRevert'
import type { InvokeChannel } from '../../shared/ipc'
import type { OAuthConfig, TokenSet } from '../auth/googleAuth'
import type { NotificationCandidate } from './notificationQueries'

export const SERVICE_PROTOCOL_VERSION = 2

export interface ServiceAuth {
  config: OAuthConfig | null
  tokens: TokenSet
  generation: number
}

export interface ServiceInitialize {
  protocolVersion: number
  dbPath: string
  userDataPath: string
  downloadsPath: string
  testMode: boolean
  testSeed?: string
  auth: ServiceAuth | null
  focused: boolean
}

export type ServiceControl =
  | { kind: 'auth'; auth: ServiceAuth | null }
  | { kind: 'sign-out' }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'resume' }
  | { kind: 'refresh-schedulers' }
  | { kind: 'stop' }

export type ServiceOperation =
  | 'resume-auth-failures'
  | 'mark-login-item-registered'
  | 'set-notification-pause'
  | 'test'

export type MainToServiceMessage =
  | { type: 'initialize'; payload: ServiceInitialize }
  | { type: 'request'; id: number; channel: InvokeChannel; args: unknown[] }
  | { type: 'internal-request'; id: number; operation: ServiceOperation; args: unknown[] }
  | { type: 'control'; payload: ServiceControl }

export interface ServiceReady {
  accountId: string | null
  schemaVersion: number
  background: {
    launchAtLogin: boolean
    loginItemRegistered: boolean
  }
}

export type ServiceEvent =
  | { kind: 'mail-changed'; serverSearchRequestId?: string }
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
  | { kind: 'token-update'; tokens: TokenSet; generation: number }
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
