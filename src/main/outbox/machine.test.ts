import { describe, expect, it } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { OutboxState } from '../../shared/outbox'
import { type Db, openDatabase } from '../db'
import { saveDraft } from './drafts'
import { type MachineEvent, type MachineRow, machineRow, persistPlan, planTransition } from './machine'

const NOW = 1_000

function row(patch: Partial<MachineRow> = {}): MachineRow {
  return {
    state: 'composing',
    gmailDraftId: null,
    sendAt: null,
    attempts: 0,
    verifyAttempts: 0,
    ...patch
  }
}

describe('outbox state machine', () => {
  it('queues a composing row for the undo window and nothing else', () => {
    expect(planTransition(row(), { type: 'queue', sendAt: NOW + 8_000 }, NOW)).toEqual({
      next: row({ state: 'queued', sendAt: NOW + 8_000 }),
      effects: ['persist']
    })
  })

  it('undoes only a queued send, and reopens only a settled failure', () => {
    expect(planTransition(row({ state: 'queued', sendAt: NOW + 1 }), { type: 'undo' }, NOW).next).toEqual(
      row()
    )
    expect(planTransition(row({ state: 'sending' }), { type: 'undo' }, NOW).effects).toEqual([])
    for (const state of ['failed', 'needs-review'] satisfies OutboxState[]) {
      const reopened = planTransition(row({ state, sendAt: null, attempts: 3 }), { type: 'reopen' }, NOW)
      expect(reopened.next).toEqual(row())
    }
    expect(planTransition(row({ state: 'sending' }), { type: 'reopen' }, NOW).effects).toEqual([])
  })

  it('fires the timer only for a queued row whose durable send time has arrived', () => {
    expect(planTransition(row({ state: 'queued', sendAt: NOW }), { type: 'timer' }, NOW).next).toEqual(
      row({ state: 'sending', sendAt: NOW })
    )
    // Boot catch-up: an elapsed window still fires.
    expect(planTransition(row({ state: 'queued', sendAt: NOW - 1 }), { type: 'timer' }, NOW).next.state).toBe(
      'sending'
    )
    // The undo window has not closed yet, and a malformed row has no window.
    expect(planTransition(row({ state: 'queued', sendAt: NOW + 1 }), { type: 'timer' }, NOW).effects).toEqual(
      []
    )
    expect(planTransition(row({ state: 'queued', sendAt: null }), { type: 'timer' }, NOW).effects).toEqual([])
  })

  it.each([
    ['after the sending write with a draft id', row({ state: 'sending', gmailDraftId: 'draft-1' }), 'verify'],
    ['between create and id persistence', row({ state: 'sending' }), 'verify-secondary']
  ])('recovers a crash %s without blind resend', (_label, sending, effect) => {
    expect(planTransition(sending, { type: 'recover' }, NOW).effects).toEqual([effect])
    // Only a draft still in Drafts licenses a resend.
    expect(planTransition(sending, { type: 'draft-present' }, NOW).effects).toEqual(['send'])
  })

  it('resets both ladders when the row gains a Gmail draft id, then verifies it', () => {
    expect(
      planTransition(
        row({ state: 'sending', attempts: 3, verifyAttempts: 2 }),
        { type: 'draft-id-assigned', gmailDraftId: 'orphan' },
        NOW
      )
    ).toEqual({
      next: row({ state: 'sending', gmailDraftId: 'orphan' }),
      effects: ['persist', 'verify']
    })
  })

  it('does not let transport retries exhaust secondary verification', () => {
    expect(
      planTransition(
        row({ state: 'sending', attempts: 9 }),
        { type: 'secondary-negative', exhausted: false, retryAt: NOW + 10_000 },
        NOW
      ).next
    ).toEqual(row({ state: 'sending', sendAt: NOW + 10_000, verifyAttempts: 1 }))
  })

  it('drops the draft id when a row is parked for review', () => {
    expect(
      planTransition(row({ state: 'sending', gmailDraftId: 'missing' }), { type: 'needs-review' }, NOW).next
    ).toEqual(row({ state: 'needs-review', attempts: 1 }))
  })

  it('keeps retryable ambiguity in sending with a durable retry time', () => {
    expect(
      planTransition(row({ state: 'sending' }), { type: 'retryable-error', retryAt: NOW + 5_000 }, NOW)
    ).toEqual({
      next: row({ state: 'sending', sendAt: NOW + 5_000, attempts: 1 }),
      effects: ['persist']
    })
  })

  it.each([
    { type: 'timer' },
    { type: 'recover' },
    { type: 'draft-present' },
    { type: 'draft-id-assigned', gmailDraftId: 'draft-1' },
    { type: 'secondary-negative', exhausted: true, retryAt: NOW },
    { type: 'needs-review' },
    { type: 'send-confirmed' },
    { type: 'preflight-retry', exhausted: false, retryAt: NOW },
    { type: 'retryable-error', retryAt: NOW },
    { type: 'permanent-error' }
  ] satisfies MachineEvent[])('leaves a settled row alone on %o', (event) => {
    const sent = row({ state: 'sent' })
    expect(planTransition(sent, event, NOW)).toEqual({ next: sent, effects: [] })
  })
})

function outboxDb(): { db: Db; id: string } {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
    'me@example.com',
    'me@example.com',
    1
  )
  const id = saveDraft(
    db,
    'me@example.com',
    { ...emptyDraftInput(), to: [{ name: '', email: 'to@example.com' }], subject: 'Persist' },
    1
  )
  return { db, id }
}

function stored(db: Db, id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT state, gmail_draft_id, gmail_message_id, send_at, attempts, verify_attempts,
              rfc_message_id, last_error, updated_at
       FROM outbox WHERE id = ?`
    )
    .get(id) as Record<string, unknown>
}

function machineColumns(db: Db, id: string): Parameters<typeof persistPlan>[1] {
  return db
    .prepare(
      `SELECT account_id, id, state, gmail_draft_id, send_at, attempts, verify_attempts
       FROM outbox WHERE id = ?`
    )
    .get(id) as Parameters<typeof persistPlan>[1]
}

describe('persistPlan', () => {
  it('writes the machine columns plus the options it was given', () => {
    const { db, id } = outboxDb()
    const { plan, persisted } = persistPlan(
      db,
      machineColumns(db, id),
      { type: 'queue', sendAt: 9_000 },
      NOW,
      {
        rfcMessageId: '<durable@example.com>',
        lastError: null,
        updatedAt: NOW
      }
    )

    expect(persisted).toBe(true)
    expect(machineRow(machineColumns(db, id))).toEqual(plan.next)
    expect(stored(db, id)).toMatchObject({
      state: 'queued',
      send_at: 9_000,
      attempts: 0,
      verify_attempts: 0,
      rfc_message_id: '<durable@example.com>',
      last_error: null,
      updated_at: NOW
    })
    db.close()
  })

  it('writes nothing at all when the transition does not apply', () => {
    const { db, id } = outboxDb()
    const before = stored(db, id)

    // `composing` is not a sending row, so there is nothing to confirm.
    const { persisted } = persistPlan(db, machineColumns(db, id), { type: 'send-confirmed' }, NOW, {
      lastError: 'ignored'
    })

    expect(persisted).toBe(false)
    expect(stored(db, id)).toEqual(before)
    db.close()
  })

  it('refuses a row another writer already moved out of the planned state', () => {
    const { db, id } = outboxDb()
    const claimed = machineColumns(db, id)
    db.prepare("UPDATE outbox SET state = 'queued', send_at = 5 WHERE id = ?").run(id)

    const { persisted } = persistPlan(db, claimed, { type: 'queue', sendAt: 9_000 }, NOW)

    expect(persisted).toBe(false)
    expect(stored(db, id)).toMatchObject({ state: 'queued', send_at: 5 })
    db.close()
  })

  it('honours the missing-draft-id and due-send-time guards', () => {
    const { db, id } = outboxDb()
    db.prepare("UPDATE outbox SET state = 'sending', gmail_draft_id = 'other' WHERE id = ?").run(id)
    expect(
      persistPlan(db, machineColumns(db, id), { type: 'draft-id-assigned', gmailDraftId: 'mine' }, NOW, {
        requireMissingDraftId: true
      }).persisted
    ).toBe(false)

    db.prepare("UPDATE outbox SET state = 'queued', gmail_draft_id = NULL, send_at = ? WHERE id = ?").run(
      NOW + 5_000,
      id
    )
    expect(
      persistPlan(db, machineColumns(db, id), { type: 'timer' }, NOW + 5_000, { requireDueSendAt: NOW })
        .persisted
    ).toBe(false)
    expect(stored(db, id)).toMatchObject({ state: 'queued' })
    db.close()
  })

  it('never erases a stored Gmail message id with a null', () => {
    const { db, id } = outboxDb()
    db.prepare("UPDATE outbox SET state = 'sending', gmail_message_id = 'kept' WHERE id = ?").run(id)

    persistPlan(db, machineColumns(db, id), { type: 'send-confirmed' }, NOW, {
      gmailMessageId: null,
      updatedAt: NOW
    })

    expect(stored(db, id)).toMatchObject({ state: 'sent', gmail_message_id: 'kept', send_at: null })
    db.close()
  })
})
