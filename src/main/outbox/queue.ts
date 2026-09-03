import { randomUUID } from 'node:crypto'
import type { DraftKind } from '../../shared/drafts'
import type {
  OutboxItem,
  OutboxState,
  PendingOutboxState,
  QueueSendResult,
  ReopenOutboxResult
} from '../../shared/outbox'
import { NEEDS_REVIEW_EXPLANATION } from '../../shared/outbox'
import { ALLOWED_UNDO_SEND_SECONDS, DEFAULT_UNDO_SEND_SECONDS } from '../../shared/outboxTuning'
import type { Db } from '../db'
import { readSetting } from '../settings'
import { getDraft } from './drafts'
import { persistPlan, type StoredMachineRow } from './machine'
import { validateMimeRecipients } from './mime'
import { outboxAddresses } from './row'

interface QueueRow {
  id: string
  account_id: string
  state: PendingOutboxState | 'composing'
  kind: DraftKind
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  updated_at: number
  gmail_draft_id: string | null
  rfc_message_id: string | null
  send_at: number | null
  attempts: number
  verify_attempts: number
  last_error: string | null
}

export function undoSendDelayMs(db: Db): number {
  const value = Number(readSetting(db, 'undoSendDelaySeconds'))
  const seconds = ALLOWED_UNDO_SEND_SECONDS.has(value) ? value : DEFAULT_UNDO_SEND_SECONDS
  return seconds * 1_000
}

export function queueSend(db: Db, accountId: string, draftId: string, now = Date.now()): QueueSendResult {
  const row = db
    .prepare(
      `SELECT id, account_id, state, kind, to_json, cc_json, bcc_json, subject, updated_at,
              gmail_draft_id, rfc_message_id, send_at, attempts, verify_attempts, last_error
       FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as QueueRow | undefined
  if (!row) throw new Error('draft is unavailable')

  const accountSeparator = accountId.lastIndexOf('@')
  if (accountSeparator <= 0 || accountSeparator === accountId.length - 1) {
    throw new Error('sender account is missing a Message-ID domain')
  }
  const accountDomain = accountId.slice(accountSeparator + 1).toLowerCase()

  validateMimeRecipients(
    {
      to: outboxAddresses(row.to_json),
      cc: outboxAddresses(row.cc_json),
      bcc: outboxAddresses(row.bcc_json)
    },
    accountId
  )
  const sendAt = now + undoSendDelayMs(db)
  const messageId = row.rfc_message_id ?? `<${randomUUID()}@${accountDomain}>`
  const { persisted } = persistPlan(db, row, { type: 'queue', sendAt }, now, {
    rfcMessageId: messageId,
    lastError: null,
    updatedAt: now
  })
  if (!persisted) throw new Error('draft could not be queued')
  return { id: draftId, sendAt }
}

export function listPendingOutbox(db: Db, accountId: string): OutboxItem[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, state, kind, to_json, cc_json, bcc_json, subject, updated_at,
              gmail_draft_id, rfc_message_id, send_at, attempts, verify_attempts, last_error
       FROM outbox
       WHERE account_id = ? AND state IN ('queued', 'sending', 'failed', 'needs-review')
       ORDER BY COALESCE(send_at, updated_at), updated_at, id`
    )
    .all(accountId) as QueueRow[]
  return rows.map((row) => ({
    id: row.id,
    state: row.state as PendingOutboxState,
    kind: row.kind,
    to: outboxAddresses(row.to_json),
    cc: outboxAddresses(row.cc_json),
    bcc: outboxAddresses(row.bcc_json),
    subject: row.subject,
    updatedAt: row.updated_at,
    sendAt: row.send_at,
    lastError: row.last_error
  }))
}

interface StoredStateRow extends StoredMachineRow {
  last_error: string | null
}

function machineColumns(db: Db, accountId: string, id: string): StoredStateRow | undefined {
  return db
    .prepare(
      `SELECT account_id, id, state, gmail_draft_id, send_at, attempts, verify_attempts, last_error
       FROM outbox WHERE account_id = ? AND id = ?`
    )
    .get(accountId, id) as StoredStateRow | undefined
}

function currentState(db: Db, accountId: string, id: string): OutboxState | undefined {
  const row = db.prepare('SELECT state FROM outbox WHERE account_id = ? AND id = ?').get(accountId, id) as
    | { state: OutboxState }
    | undefined
  return row?.state
}

function unavailableUndoMessage(state: OutboxState | undefined): string {
  if (state === 'sent') return 'Already sent'
  if (state === 'sending') return 'Sending in progress'
  if (state === 'failed') return 'Send failed — open it from Outbox to retry'
  if (state === 'needs-review') return 'Send needs review — check your Sent mail from Outbox'
  if (state === 'composing' || state === 'drafted') return 'Message is already a draft'
  return 'Message is no longer in the Outbox'
}

export function undoQueuedSend(db: Db, accountId: string, id: string, now = Date.now()): ReopenOutboxResult {
  const row = machineColumns(db, accountId, id)
  if (!row) return { draft: null, error: unavailableUndoMessage(undefined) }
  const { persisted } = persistPlan(db, row, { type: 'undo' }, now, {
    lastError: null,
    updatedAt: now
  })
  if (!persisted) return { draft: null, error: unavailableUndoMessage(currentState(db, accountId, id)) }
  return { draft: getDraft(db, accountId, id), error: null }
}

export function reopenPendingOutbox(
  db: Db,
  accountId: string,
  id: string,
  now = Date.now()
): ReopenOutboxResult {
  const row = machineColumns(db, accountId, id)
  if (!row || (row.state !== 'failed' && row.state !== 'needs-review')) {
    return { draft: null, error: row?.state === 'sending' ? 'Sending in progress' : 'Message is unavailable' }
  }
  const explanation =
    row.state === 'needs-review' ? NEEDS_REVIEW_EXPLANATION : row.last_error || 'Message could not be sent'
  const { persisted } = persistPlan(db, row, { type: 'reopen' }, now, {
    rfcMessageId: null,
    lastError: null,
    updatedAt: now
  })
  if (!persisted) return { draft: null, error: unavailableUndoMessage(currentState(db, accountId, id)) }
  return { draft: getDraft(db, accountId, id), error: explanation }
}
