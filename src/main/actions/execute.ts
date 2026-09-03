import { errorMessage } from '../../shared/error'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { MAIL_RETRY_FIRST_MS, MAIL_RETRY_MAX_MS, MAIL_RETRY_SECOND_MS } from '../sync/tuning'

export interface QueueIntent {
  kind: 'modifyLabels'
  threadId: string
  add: string[]
  remove: string[]
}

export async function executeIntent(provider: MailActionProvider, intent: QueueIntent): Promise<void> {
  await provider.modifyThread(intent.threadId, intent.add, intent.remove)
}

export function isPermanentActionError(error: unknown): boolean {
  return (
    error instanceof GmailApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !error.retryable &&
    error.status !== 401
  )
}

export type ActionErrorKind = 'auth' | 'permanent' | 'retryable'

const STORED_ERROR_PREFIX = 'attn-action-error:'

interface StoredActionError {
  version: 1
  kind: ActionErrorKind
  message: string
}

export function storeActionError(error: unknown, kind: ActionErrorKind): string {
  const stored: StoredActionError = {
    version: 1,
    kind,
    message: errorMessage(error)
  }
  return `${STORED_ERROR_PREFIX}${JSON.stringify(stored)}`
}

export function storedActionErrorKind(message: string | null | undefined): ActionErrorKind | null {
  if (typeof message !== 'string') return null
  if (message.startsWith(STORED_ERROR_PREFIX)) {
    try {
      const stored = JSON.parse(message.slice(STORED_ERROR_PREFIX.length)) as Partial<StoredActionError>
      if (
        stored.version === 1 &&
        (stored.kind === 'auth' || stored.kind === 'permanent' || stored.kind === 'retryable')
      ) {
        return stored.kind
      }
    } catch {
      return null
    }
  }
  return null
}

export function isStoredAuthActionError(message: string | null | undefined): boolean {
  return storedActionErrorKind(message) === 'auth'
}

export function classifyActionError(error: unknown): ActionErrorKind {
  if (error instanceof GmailAuthError || (error instanceof GmailApiError && error.status === 401)) {
    return 'auth'
  }
  return isPermanentActionError(error) ? 'permanent' : 'retryable'
}

export function retryDelayMs(previousAttempts: number): number {
  return previousAttempts === 0
    ? MAIL_RETRY_FIRST_MS
    : previousAttempts === 1
      ? MAIL_RETRY_SECOND_MS
      : MAIL_RETRY_MAX_MS
}
