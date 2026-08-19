import { errorMessage } from '../../shared/error'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'

export type QueueIntent =
  | { kind: 'modifyLabels'; threadId: string; add: string[]; remove: string[] }
  | { kind: 'trash' | 'untrash'; threadId: string }

export async function executeIntent(provider: MailActionProvider, intent: QueueIntent): Promise<void> {
  if (intent.kind === 'modifyLabels') {
    await provider.modifyThread(intent.threadId, intent.add, intent.remove)
  } else if (intent.kind === 'trash') {
    await provider.trashThread(intent.threadId)
  } else {
    await provider.untrashThread(intent.threadId)
    await provider.modifyThread(intent.threadId, ['INBOX'], [])
  }
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
  // Compatibility for rows written before typed stored errors were introduced.
  return /\bfailed \(401\):/i.test(message) ? 'auth' : null
}

export function isTypedStoredActionError(message: string | null | undefined): boolean {
  return (
    typeof message === 'string' &&
    message.startsWith(STORED_ERROR_PREFIX) &&
    storedActionErrorKind(message) !== null
  )
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
  return previousAttempts === 0 ? 5_000 : previousAttempts === 1 ? 30_000 : 60_000
}
