import type { OutboxState } from '../../shared/outbox'

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
  | { type: 'timer' }
  | { type: 'recover' }
  | { type: 'draft-present' }
  | { type: 'draft-missing' }
  | { type: 'secondary-draft-found'; gmailDraftId: string }
  | { type: 'secondary-message-found' }
  | { type: 'secondary-negative'; exhausted: boolean; retryAt: number }
  | { type: 'needs-review' }
  | { type: 'send-confirmed' }
  | { type: 'preflight-retry'; exhausted: boolean; retryAt: number }
  | { type: 'verification-error'; retryAt: number }
  | { type: 'retryable-error'; retryAt: number }
  | { type: 'permanent-error' }

export type MachineEffect = 'persist' | 'arm-timer' | 'verify' | 'verify-secondary' | 'send' | 'notify'

export interface TransitionPlan {
  next: MachineRow
  effects: MachineEffect[]
}

function unchanged(row: MachineRow): TransitionPlan {
  return { next: row, effects: [] }
}

/**
 * Pure transition authority for one durable outbox row. Effects are ordered:
 * `persist` always precedes the network-bearing `verify`/`send` effects.
 */
export function planTransition(row: MachineRow, event: MachineEvent, now: number): TransitionPlan {
  if (event.type === 'queue') {
    if (row.state !== 'composing') return unchanged(row)
    return {
      next: { ...row, state: 'queued', sendAt: event.sendAt, attempts: 0, verifyAttempts: 0 },
      effects: ['persist', 'arm-timer', 'notify']
    }
  }

  if (event.type === 'undo') {
    if (row.state !== 'queued') return { next: row, effects: ['notify'] }
    return {
      next: { ...row, state: 'composing', sendAt: null, attempts: 0, verifyAttempts: 0 },
      effects: ['persist', 'notify']
    }
  }

  if (event.type === 'timer') {
    if (row.state !== 'queued' || row.sendAt === null) return unchanged(row)
    if (row.sendAt > now) return { next: row, effects: ['arm-timer'] }
    return {
      next: { ...row, state: 'sending' },
      effects: ['persist', 'notify', 'send']
    }
  }

  if (event.type === 'recover') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: row,
      effects: [row.gmailDraftId ? 'verify' : 'verify-secondary']
    }
  }

  if (event.type === 'draft-present') {
    return row.state === 'sending' ? { next: row, effects: ['send'] } : unchanged(row)
  }

  if (event.type === 'draft-missing' || event.type === 'secondary-message-found') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'sent', sendAt: null },
      effects: ['persist', 'notify']
    }
  }

  if (event.type === 'secondary-draft-found') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, gmailDraftId: event.gmailDraftId },
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
        effects: ['persist', 'notify']
      }
    }
    return {
      next: { ...row, sendAt: event.retryAt, attempts: 0, verifyAttempts: row.verifyAttempts + 1 },
      effects: ['persist', 'arm-timer']
    }
  }

  if (event.type === 'needs-review') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'needs-review', sendAt: null, attempts: row.attempts + 1 },
      effects: ['persist', 'notify']
    }
  }

  if (event.type === 'send-confirmed') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'sent', sendAt: null },
      effects: ['persist', 'notify']
    }
  }

  if (event.type === 'preflight-retry') {
    if (row.state !== 'sending') return unchanged(row)
    // A preflight failure never reached Gmail, so an exhausted ladder is a
    // plain failure the user can see and act on — never an ambiguous send.
    if (event.exhausted) {
      return {
        next: { ...row, state: 'failed', sendAt: null, attempts: row.attempts + 1 },
        effects: ['persist', 'notify']
      }
    }
    return {
      next: { ...row, state: 'queued', sendAt: event.retryAt, attempts: row.attempts + 1 },
      effects: ['persist', 'arm-timer']
    }
  }

  if (event.type === 'verification-error') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, sendAt: event.retryAt, attempts: row.attempts + 1 },
      effects: ['persist', 'arm-timer']
    }
  }

  if (event.type === 'retryable-error') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, sendAt: event.retryAt, attempts: row.attempts + 1 },
      effects: ['persist', 'arm-timer']
    }
  }

  if (event.type === 'permanent-error') {
    if (row.state !== 'sending') return unchanged(row)
    return {
      next: { ...row, state: 'failed', sendAt: null, attempts: row.attempts + 1 },
      effects: ['persist', 'notify']
    }
  }

  return unchanged(row)
}
