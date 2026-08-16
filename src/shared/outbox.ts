import type { Draft } from './drafts'

export type OutboxState =
  | 'composing'
  | 'drafted'
  | 'discarding'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'needs-review'

export type PendingOutboxState = Extract<OutboxState, 'queued' | 'sending' | 'failed' | 'needs-review'>

export interface OutboxItem {
  id: string
  state: PendingOutboxState
  kind: Draft['kind']
  to: Draft['to']
  cc: Draft['cc']
  bcc: Draft['bcc']
  subject: string
  updatedAt: number
  sendAt: number | null
  lastError: string | null
}

export interface QueueSendResult {
  id: string
  sendAt: number
}

export interface ReopenOutboxResult {
  draft: Draft | null
  error: string | null
}

export type OutboxChanged = { kind: 'changed' } | { kind: 'failed'; id: string; error: string }

export interface OutboxProgress {
  id: string
  completedBytes: number
  totalBytes: number
  completedAttachments: number
  totalAttachments: number
}
