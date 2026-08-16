import { describe, expect, it } from 'vitest'
import { type MachineEvent, type MachineRow, planTransition } from './machine'

const NOW = 1_000

function row(patch: Partial<MachineRow> = {}): MachineRow {
  return {
    state: 'composing',
    gmailDraftId: null,
    sendAt: null,
    attempts: 0,
    ...patch
  }
}

describe('outbox state machine', () => {
  it('durably queues before arming and notifying, then waits for the undo window', () => {
    const queued = planTransition(row(), { type: 'queue', sendAt: NOW + 8_000 }, NOW)
    expect(queued).toEqual({
      next: row({ state: 'queued', sendAt: NOW + 8_000 }),
      effects: ['persist', 'arm-timer', 'notify']
    })
    expect(planTransition(queued.next, { type: 'timer' }, NOW).effects).toEqual(['arm-timer'])
  })

  it('undoes only a queued send and consumes undo after the sender has fired', () => {
    expect(planTransition(row({ state: 'queued', sendAt: NOW + 1 }), { type: 'undo' }, NOW)).toEqual({
      next: row(),
      effects: ['persist', 'notify']
    })
    expect(planTransition(row({ state: 'sending' }), { type: 'undo' }, NOW)).toEqual({
      next: row({ state: 'sending' }),
      effects: ['notify']
    })
  })

  it('persists sending before the first network effect', () => {
    expect(planTransition(row({ state: 'queued', sendAt: NOW }), { type: 'timer' }, NOW)).toEqual({
      next: row({ state: 'sending', sendAt: NOW }),
      effects: ['persist', 'notify', 'send']
    })
  })

  it.each([
    ['after the sending write with a draft id', row({ state: 'sending', gmailDraftId: 'draft-1' }), 'verify'],
    ['between create and id persistence', row({ state: 'sending' }), 'verify-secondary']
  ])('recovers a crash %s without blind resend', (_label, sending, effect) => {
    expect(planTransition(sending, { type: 'recover' }, NOW).effects).toEqual([effect])
  })

  it('resends only when the durable draft is present and marks sent when it is gone', () => {
    const sending = row({ state: 'sending', gmailDraftId: 'draft-1' })
    expect(planTransition(sending, { type: 'draft-present' }, NOW).effects).toEqual(['send'])
    expect(planTransition(sending, { type: 'draft-missing' }, NOW)).toEqual({
      next: row({ state: 'sent', gmailDraftId: 'draft-1' }),
      effects: ['persist', 'notify']
    })
  })

  it('uses secondary search to recover an orphaned draft or accepted message', () => {
    const sending = row({ state: 'sending' })
    expect(planTransition(sending, { type: 'secondary-draft-found', gmailDraftId: 'orphan' }, NOW)).toEqual({
      next: row({ state: 'sending', gmailDraftId: 'orphan' }),
      effects: ['persist', 'verify']
    })
    expect(planTransition(sending, { type: 'secondary-message-found' }, NOW).next.state).toBe('sent')
  })

  it('never treats one secondary-search negative as permission to resend', () => {
    const sending = row({ state: 'sending', attempts: 2 })
    expect(
      planTransition(sending, { type: 'secondary-negative', exhausted: false, retryAt: NOW + 10_000 }, NOW)
    ).toEqual({
      next: row({ state: 'sending', attempts: 3, sendAt: NOW + 10_000 }),
      effects: ['persist', 'arm-timer']
    })
  })

  it('parks residual ambiguity for review after the bounded verification window', () => {
    const plan = planTransition(
      row({ state: 'sending', attempts: 5 }),
      { type: 'secondary-negative', exhausted: true, retryAt: NOW },
      NOW
    )
    expect(plan.next).toEqual(row({ state: 'needs-review', attempts: 6 }))
    expect(plan.effects).toEqual(['persist', 'notify'])
  })

  it('parks a draft that disappeared before drafts.send instead of marking it sent', () => {
    expect(
      planTransition(row({ state: 'sending', gmailDraftId: 'missing' }), { type: 'needs-review' }, NOW)
    ).toEqual({
      next: row({ state: 'needs-review', gmailDraftId: 'missing', attempts: 1 }),
      effects: ['persist', 'notify']
    })
  })

  it.each([
    [{ type: 'send-confirmed' }, 'sent'],
    [{ type: 'permanent-error' }, 'failed']
  ] satisfies [MachineEvent, string][])('settles %o as %s', (event, state) => {
    expect(planTransition(row({ state: 'sending' }), event, NOW).next.state).toBe(state)
  })

  it('keeps retryable ambiguity in sending with a durable retry time', () => {
    expect(
      planTransition(row({ state: 'sending' }), { type: 'retryable-error', retryAt: NOW + 5_000 }, NOW)
    ).toEqual({
      next: row({ state: 'sending', sendAt: NOW + 5_000, attempts: 1 }),
      effects: ['persist', 'arm-timer']
    })
  })

  it('returns a retryable preflight failure to queued because no remote mutation started', () => {
    expect(
      planTransition(row({ state: 'sending' }), { type: 'preflight-retry', retryAt: NOW + 5_000 }, NOW)
    ).toEqual({
      next: row({ state: 'queued', sendAt: NOW + 5_000, attempts: 1 }),
      effects: ['persist', 'arm-timer']
    })
  })

  it('does not count verification transport errors as negative Message-ID checks', () => {
    expect(
      planTransition(
        row({ state: 'sending', attempts: 2 }),
        { type: 'verification-error', retryAt: NOW + 5_000 },
        NOW
      )
    ).toEqual({
      next: row({ state: 'sending', sendAt: NOW + 5_000, attempts: 2 }),
      effects: ['persist', 'arm-timer']
    })
  })

  it('catches up an elapsed queued window on boot', () => {
    expect(planTransition(row({ state: 'queued', sendAt: NOW - 1 }), { type: 'timer' }, NOW).next.state).toBe(
      'sending'
    )
  })
})
