import { randomUUID } from 'node:crypto'
import type { MailAddress } from '../../shared/address'
import type { DraftKind } from '../../shared/drafts'
import type { OutboxItem, PendingOutboxState, QueueSendResult, ReopenOutboxResult } from '../../shared/outbox'
import type { Db } from '../db'
import { readSetting } from '../settings'
import { getDraft } from './drafts'
import { planTransition } from './machine'
import { validateMimeRecipients } from './mime'

const DEFAULT_UNDO_SEND_SECONDS = 8
const ALLOWED_UNDO_SEND_SECONDS = new Set([0, 5, 8, 10, 20, 30])

interface QueueRow {
  id: string
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

function parseAddresses(value: string): MailAddress[] {
  return JSON.parse(value) as MailAddress[]
}

export function undoSendDelayMs(db: Db): number {
  const value = Number(readSetting(db, 'undoSendDelaySeconds'))
  const seconds = ALLOWED_UNDO_SEND_SECONDS.has(value) ? value : DEFAULT_UNDO_SEND_SECONDS
  return seconds * 1_000
}

export function queueSend(db: Db, accountId: string, draftId: string, now = Date.now()): QueueSendResult {
  const row = db
    .prepare(
      `SELECT id, state, kind, to_json, cc_json, bcc_json, subject, updated_at,
              gmail_draft_id, rfc_message_id, send_at, attempts, verify_attempts, last_error
       FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as QueueRow | undefined
  if (!row) throw new Error('draft is unavailable')

  validateMimeRecipients(
    {
      to: parseAddresses(row.to_json),
      cc: parseAddresses(row.cc_json),
      bcc: parseAddresses(row.bcc_json)
    },
    accountId
  )
  const sendAt = now + undoSendDelayMs(db)
  const plan = planTransition(
    {
      state: row.state,
      gmailDraftId: row.gmail_draft_id,
      sendAt: row.send_at,
      attempts: row.attempts,
      verifyAttempts: row.verify_attempts
    },
    { type: 'queue', sendAt },
    now
  )
  if (plan.next.state !== 'queued') throw new Error('draft could not be queued')

  const accountDomain = accountId.slice(accountId.lastIndexOf('@') + 1).toLowerCase()
  const messageId = row.rfc_message_id ?? `<${randomUUID()}@${accountDomain}>`
  const result = db
    .prepare(
      `UPDATE outbox SET state = 'queued', rfc_message_id = ?, send_at = ?, attempts = 0,
       verify_attempts = 0, last_error = NULL, updated_at = ?
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .run(messageId, sendAt, now, accountId, draftId)
  if (result.changes === 0) throw new Error('draft could not be queued')
  return { id: draftId, sendAt }
}

export function listPendingOutbox(db: Db, accountId: string): OutboxItem[] {
  const rows = db
    .prepare(
      `SELECT id, state, kind, to_json, cc_json, bcc_json, subject, updated_at,
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
    to: parseAddresses(row.to_json),
    cc: parseAddresses(row.cc_json),
    bcc: parseAddresses(row.bcc_json),
    subject: row.subject,
    updatedAt: row.updated_at,
    sendAt: row.send_at,
    lastError: row.last_error
  }))
}

export function pendingOutboxCount(db: Db, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE account_id = ? AND state IN ('queued', 'sending', 'failed', 'needs-review')`
    )
    .get(accountId) as { count: number }
  return row.count
}

export function undoQueuedSend(db: Db, accountId: string, id: string, now = Date.now()): ReopenOutboxResult {
  const row = db
    .prepare(
      `SELECT state, gmail_draft_id, send_at, attempts, verify_attempts FROM outbox
       WHERE account_id = ? AND id = ?`
    )
    .get(accountId, id) as
    | {
        state: string
        gmail_draft_id: string | null
        send_at: number | null
        attempts: number
        verify_attempts: number
      }
    | undefined
  if (!row) return { draft: null, error: 'Message is no longer in the Outbox' }
  const plan = planTransition(
    {
      state: row.state as QueueRow['state'],
      gmailDraftId: row.gmail_draft_id,
      sendAt: row.send_at,
      attempts: row.attempts,
      verifyAttempts: row.verify_attempts
    },
    { type: 'undo' },
    now
  )
  if (plan.next.state !== 'composing') return { draft: null, error: 'Already sent' }
  const undone = db
    .prepare(
      `UPDATE outbox SET state = 'composing', send_at = NULL, attempts = 0, verify_attempts = 0,
       last_error = NULL, updated_at = ? WHERE account_id = ? AND id = ? AND state = 'queued'`
    )
    .run(now, accountId, id)
  if (undone.changes === 0) return { draft: null, error: 'Already sent' }
  return { draft: getDraft(db, accountId, id), error: null }
}

export function reopenPendingOutbox(
  db: Db,
  accountId: string,
  id: string,
  now = Date.now()
): ReopenOutboxResult {
  const row = db
    .prepare('SELECT state, last_error FROM outbox WHERE account_id = ? AND id = ?')
    .get(accountId, id) as { state: string; last_error: string | null } | undefined
  if (!row || (row.state !== 'failed' && row.state !== 'needs-review')) {
    return { draft: null, error: row?.state === 'sending' ? 'Sending in progress' : 'Message is unavailable' }
  }
  const explanation =
    row.state === 'needs-review'
      ? "We couldn't confirm this was sent — check your Sent mail before resending"
      : row.last_error || 'Message could not be sent'
  db.prepare(
    `UPDATE outbox SET state = 'composing', send_at = NULL, attempts = 0, verify_attempts = 0,
     updated_at = ?
     WHERE account_id = ? AND id = ? AND state IN ('failed', 'needs-review')`
  ).run(now, accountId, id)
  return { draft: getDraft(db, accountId, id), error: explanation }
}
