import type { OutboxState } from '../../shared/outbox'
import type { Db } from '../db'

export interface MachineRow {
  state: OutboxState
  gmailDraftId: string | null
  sendAt: number | null
  attempts: number
  verifyAttempts: number
}

export type MachineEvent =
  | { type: 'queue'; sendAt: number }
  | { type: 'undo' }
  | { type: 'reopen' }
  | { type: 'timer' }
  | { type: 'recover' }
  | { type: 'draft-present' }
  | { type: 'draft-id-assigned'; gmailDraftId: string }
  | { type: 'secondary-negative'; exhausted: boolean; retryAt: number }
  | { type: 'needs-review' }
  | { type: 'send-confirmed' }
  | { type: 'preflight-retry'; exhausted: boolean; retryAt: number }
  | { type: 'retryable-error'; retryAt: number }
  | { type: 'permanent-error' }

/**
 * Every effect a caller acts on. `persist` gates {@link persistPlan}'s write,
 * and the network effects are ordered after it, so a row is durable before
 * Gmail is asked to do anything about it.
 */
type MachineEffect = 'persist' | 'verify' | 'verify-secondary' | 'send'

export interface TransitionPlan {
  next: MachineRow
  effects: MachineEffect[]
}

function unchanged(row: MachineRow): TransitionPlan {
  return { next: row, effects: [] }
}

/** Pure transition authority for one durable outbox row. */
export function planTransition(row: MachineRow, event: MachineEvent, now: number): TransitionPlan {
  if (event.type === 'queue') {
    if (row.state !== 'composing') return unchanged(row)
    return {
      next: { ...row, state: 'queued', sendAt: event.sendAt, attempts: 0, verifyAttempts: 0 },
      effects: ['persist']
    }
  }

  if (event.type === 'undo') {
    if (row.state !== 'queued') return unchanged(row)
    return {
      next: { ...row, state: 'composing', sendAt: null, attempts: 0, verifyAttempts: 0 },
      effects: ['persist']
    }
  }

  if (event.type === 'reopen') {
    if (row.state !== 'failed' && row.state !== 'needs-review') return unchanged(row)
    return {
      next: { ...row, state: 'composing', sendAt: null, attempts: 0, verifyAttempts: 0 },
      effects: ['persist']
    }
  }

  if (event.type === 'timer') {
    if (row.state !== 'queued' || row.sendAt === null || row.sendAt > now) return unchanged(row)
    return { next: { ...row, state: 'sending' }, effects: ['persist'] }
  }

  if (event.type === 'recover') {
    if (row.state !== 'sending') return unchanged(row)
    return { next: row, effects: [row.gmailDraftId ? 'verify' : 'verify-secondary'] }
  }

  if (event.type === 'draft-present') {
    return row.state === 'sending' ? { next: row, effects: ['send'] } : unchanged(row)
  }

  // A Gmail draft id becomes this row's, whether Gmail just minted it or the
  // Message-ID search found the one an interrupted create left behind. Either
  // way the row owns a live draft again, so both ladders reset.
  if (event.type === 'draft-id-assigned') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, gmailDraftId: event.gmailDraftId, attempts: 0, verifyAttempts: 0 },
      effects: ['persist', 'verify']
    }
  }

  if (event.type === 'secondary-negative') {
    if (row.state !== 'sending') return unchanged(row)
    if (event.exhausted) {
      return {
        next: {
          ...row,
          state: 'needs-review',
          sendAt: null,
          attempts: 0,
          verifyAttempts: row.verifyAttempts + 1
        },
        effects: ['persist']
      }
    }
    return {
      next: { ...row, sendAt: event.retryAt, attempts: 0, verifyAttempts: row.verifyAttempts + 1 },
      effects: ['persist']
    }
  }

  // The draft this row owned is gone and no message carries its Message-ID.
  // The id goes with it: nothing may be sent or verified against it again.
  if (event.type === 'needs-review') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'needs-review', gmailDraftId: null, sendAt: null, attempts: row.attempts + 1 },
      effects: ['persist']
    }
  }

  if (event.type === 'send-confirmed') {
    if (row.state !== 'sending') return unchanged(row)
    return { next: { ...row, state: 'sent', sendAt: null }, effects: ['persist'] }
  }

  if (event.type === 'preflight-retry') {
    if (row.state !== 'sending') return unchanged(row)
    // A preflight failure never reached Gmail, so an exhausted ladder is a
    // plain failure the user can see and act on — never an ambiguous send.
    if (event.exhausted) {
      return {
        next: { ...row, state: 'failed', sendAt: null, attempts: row.attempts + 1 },
        effects: ['persist']
      }
    }
    return {
      next: { ...row, state: 'queued', sendAt: event.retryAt, attempts: row.attempts + 1 },
      effects: ['persist']
    }
  }

  // Ambiguity — a transport failure, or a verification read that could not be
  // completed — keeps the row in `sending` with a durable retry time.
  if (event.type === 'retryable-error') {
    if (row.state !== 'sending') return unchanged(row)
    return { next: { ...row, sendAt: event.retryAt, attempts: row.attempts + 1 }, effects: ['persist'] }
  }

  if (event.type === 'permanent-error') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'failed', sendAt: null, attempts: row.attempts + 1 },
      effects: ['persist']
    }
  }

  return unchanged(row)
}

/** The stored columns the machine owns, exactly as SQLite returns them. */
export interface StoredMachineRow {
  account_id: string
  id: string
  state: OutboxState
  gmail_draft_id: string | null
  send_at: number | null
  attempts: number
  verify_attempts: number
}

export function machineRow(row: StoredMachineRow): MachineRow {
  return {
    state: row.state,
    gmailDraftId: row.gmail_draft_id,
    sendAt: row.send_at,
    attempts: row.attempts,
    verifyAttempts: row.verify_attempts
  }
}

export interface PersistPlanOptions {
  /** Written verbatim; `undefined` leaves the stored value alone. */
  lastError?: string | null
  updatedAt?: number
  rfcMessageId?: string | null
  /** Written through COALESCE, so a null never erases an id already stored. */
  gmailMessageId?: string | null
  /** Additional guard: the row must still have no Gmail draft id. */
  requireMissingDraftId?: boolean
  /** Additional guard: the row's send time must still be set and due at this instant. */
  requireDueSendAt?: number
}

export interface PersistedTransition {
  plan: TransitionPlan
  /** True only when this transition's own write claimed the row. */
  persisted: boolean
}

/**
 * The single writer for the columns {@link planTransition} owns. The stored
 * state the plan was computed from is part of the guard, so a row another
 * drain (or an undo) already moved is never overwritten — the caller sees
 * `persisted: false` and re-reads.
 */
export function persistPlan(
  db: Db,
  row: StoredMachineRow,
  event: MachineEvent,
  now: number,
  options: PersistPlanOptions = {}
): PersistedTransition {
  const plan = planTransition(machineRow(row), event, now)
  if (!plan.effects.includes('persist')) return { plan, persisted: false }

  const assignments = [
    'state = ?',
    'gmail_draft_id = ?',
    'send_at = ?',
    'attempts = ?',
    'verify_attempts = ?'
  ]
  const values: Array<string | number | null> = [
    plan.next.state,
    plan.next.gmailDraftId,
    plan.next.sendAt,
    plan.next.attempts,
    plan.next.verifyAttempts
  ]
  if (options.rfcMessageId !== undefined) {
    assignments.push('rfc_message_id = ?')
    values.push(options.rfcMessageId)
  }
  if (options.gmailMessageId !== undefined) {
    assignments.push('gmail_message_id = COALESCE(?, gmail_message_id)')
    values.push(options.gmailMessageId)
  }
  if (options.lastError !== undefined) {
    assignments.push('last_error = ?')
    values.push(options.lastError)
  }
  if (options.updatedAt !== undefined) {
    assignments.push('updated_at = ?')
    values.push(options.updatedAt)
  }

  const guards = ['account_id = ?', 'id = ?', 'state = ?']
  const guardValues: Array<string | number> = [row.account_id, row.id, row.state]
  if (options.requireMissingDraftId) guards.push('gmail_draft_id IS NULL')
  if (options.requireDueSendAt !== undefined) {
    guards.push('send_at IS NOT NULL', 'send_at <= ?')
    guardValues.push(options.requireDueSendAt)
  }

  const changes = db
    .prepare(`UPDATE outbox SET ${assignments.join(', ')} WHERE ${guards.join(' AND ')}`)
    .run(...values, ...guardValues).changes
  return { plan, persisted: changes > 0 }
}
