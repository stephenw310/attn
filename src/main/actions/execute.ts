import { GmailApiError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'

export type QueueIntent =
  | { kind: 'modifyLabels'; threadId: string; add: string[]; remove: string[] }
  | { kind: 'trash' | 'untrash'; threadId: string }

export async function executeIntent(provider: MailProvider, intent: QueueIntent): Promise<void> {
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
    error.status !== 404
  )
}

export function retryDelayMs(previousAttempts: number): number {
  return previousAttempts === 0 ? 5_000 : previousAttempts === 1 ? 30_000 : 60_000
}
