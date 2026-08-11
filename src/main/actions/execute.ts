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
  }
}
