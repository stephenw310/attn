import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { Db } from '../db'
import { openDatabase } from '../db'
import { saveDraft } from './drafts'
import { queueSend, reopenPendingOutbox, undoQueuedSend, undoSendDelayMs } from './queue'

function settingsDb(value: string | undefined): Db {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(() => (value === undefined ? undefined : { value })) }))
  } as unknown as Db
}

function memoryDb(accountId: string): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(accountId, accountId, 1)
  return db
}

function composingDraft(db: Db, accountId: string): string {
  const id = saveDraft(
    db,
    accountId,
    { ...emptyDraftInput(), to: [{ name: '', email: 'to@example.com' }], subject: 'Message ID' },
    1
  )
  db.prepare('UPDATE outbox SET attempts = 4, verify_attempts = 5 WHERE id = ?').run(id)
  return id
}

describe('undo send setting', () => {
  it('defaults to five seconds and accepts only supported explicit values', () => {
    expect(undoSendDelayMs(settingsDb(undefined))).toBe(5_000)
    expect(undoSendDelayMs(settingsDb('20'))).toBe(20_000)
    expect(undoSendDelayMs(settingsDb('0'))).toBe(0)
    expect(undoSendDelayMs(settingsDb('7'))).toBe(5_000)
    expect(undoSendDelayMs(settingsDb('not-a-number'))).toBe(5_000)
  })

  it('uses the sender account domain for a durable Message-ID and resets both counters', () => {
    const db = memoryDb('me@workspace.example')
    const id = composingDraft(db, 'me@workspace.example')

    expect(queueSend(db, 'me@workspace.example', id, 1_000)).toEqual({ id, sendAt: 6_000 })
    const row = db
      .prepare(
        `SELECT state, rfc_message_id, send_at, attempts, verify_attempts, last_error, updated_at
         FROM outbox WHERE id = ?`
      )
      .get(id) as Record<string, unknown>
    expect(row.rfc_message_id).toMatch(/^<[0-9a-f-]+@workspace\.example>$/)
    expect(row).toMatchObject({
      state: 'queued',
      send_at: 6_000,
      attempts: 0,
      verify_attempts: 0,
      last_error: null,
      updated_at: 1_000
    })
    db.close()
  })

  it('refuses to derive a Message-ID domain from an account id without an @', () => {
    const db = memoryDb('missing-domain')
    const id = composingDraft(db, 'missing-domain')

    expect(() => queueSend(db, 'missing-domain', id, 1_000)).toThrow(
      'sender account is missing a Message-ID domain'
    )
    expect(db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)).toEqual({ state: 'composing' })
    db.close()
  })
})

describe('queued send undo races', () => {
  it.each([
    ['sending', 'Sending in progress'],
    ['failed', 'Send failed — open it from Outbox to retry'],
    ['needs-review', 'Send needs review — check your Sent mail from Outbox']
  ])('reports %s accurately instead of claiming it was sent', (state, error) => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          state,
          gmail_draft_id: null,
          send_at: null,
          attempts: 1,
          verify_attempts: 0
        }))
      }))
    } as unknown as Db

    expect(undoQueuedSend(db, 'me@example.com', 'draft-1')).toEqual({ draft: null, error })
  })

  it('reloads the winning state when the timer claims a queued row during undo', () => {
    let selected = 0
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => {
          selected++
          return selected === 1
            ? {
                state: 'queued',
                gmail_draft_id: null,
                send_at: 1,
                attempts: 0,
                verify_attempts: 0
              }
            : { state: 'sending' }
        }),
        run: vi.fn(() => ({ changes: sql.startsWith('UPDATE outbox') ? 0 : 1 }))
      }))
    } as unknown as Db

    expect(undoQueuedSend(db, 'me@example.com', 'draft-1')).toEqual({
      draft: null,
      error: 'Sending in progress'
    })
  })
})

describe('failed outbox reopen', () => {
  it('clears stale failure state and mints a fresh Message-ID on resend', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'me@example.com',
      'me@example.com',
      1
    )
    const id = saveDraft(
      db,
      'me@example.com',
      {
        ...emptyDraftInput(),
        to: [{ name: '', email: 'to@example.com' }],
        subject: 'Retry safely'
      },
      10
    )
    db.prepare(
      "UPDATE outbox SET state = 'needs-review', rfc_message_id = ?, last_error = ? WHERE id = ?"
    ).run('<old@example.com>', 'stale failure', id)

    expect(reopenPendingOutbox(db, 'me@example.com', id, 20)).toMatchObject({
      draft: { id },
      error: "We couldn't confirm this was sent — check your Sent mail before resending"
    })
    expect(db.prepare('SELECT rfc_message_id, last_error FROM outbox WHERE id = ?').get(id)).toEqual({
      rfc_message_id: null,
      last_error: null
    })

    queueSend(db, 'me@example.com', id, 30)
    const queued = db.prepare('SELECT rfc_message_id FROM outbox WHERE id = ?').get(id) as {
      rfc_message_id: string
    }
    expect(queued.rfc_message_id).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(queued.rfc_message_id).not.toBe('<old@example.com>')
    db.close()
  })

  it('reports the winning state when another transition wins the reopen race', () => {
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() =>
          sql.includes('last_error') ? { state: 'failed', last_error: 'failed' } : { state: 'sending' }
        ),
        run: vi.fn(() => ({ changes: 0 }))
      }))
    } as unknown as Db

    expect(reopenPendingOutbox(db, 'me@example.com', 'draft-1')).toEqual({
      draft: null,
      error: 'Sending in progress'
    })
  })
})
