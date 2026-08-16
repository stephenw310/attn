import { GmailApiError } from '../gmail/client'
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
    error.status !== 401 &&
    error.status !== 404
  )
}

export type ActionErrorKind = 'auth' | 'permanent' | 'retryable'

export function isStoredAuthActionError(message: string | null | undefined): boolean {
  return typeof message === 'string' && /\bfailed \(401\):/i.test(message)
}

export function classifyActionError(error: unknown): ActionErrorKind {
  if (
    (error instanceof GmailApiError && error.status === 401) ||
    isStoredAuthActionError(error instanceof Error ? error.message : String(error))
  ) {
    return 'auth'
  }
  return isPermanentActionError(error) ? 'permanent' : 'retryable'
}

export function retryDelayMs(previousAttempts: number): number {
  return previousAttempts === 0 ? 5_000 : previousAttempts === 1 ? 30_000 : 60_000
}
