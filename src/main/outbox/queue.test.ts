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

describe('undo send setting', () => {
  it('defaults to eight seconds and accepts only supported explicit values', () => {
    expect(undoSendDelayMs(settingsDb(undefined))).toBe(8_000)
    expect(undoSendDelayMs(settingsDb('20'))).toBe(20_000)
    expect(undoSendDelayMs(settingsDb('0'))).toBe(0)
    expect(undoSendDelayMs(settingsDb('7'))).toBe(8_000)
    expect(undoSendDelayMs(settingsDb('not-a-number'))).toBe(8_000)
  })

  it('uses the sender account domain for a durable Message-ID and resets both counters', () => {
    const run = vi.fn(() => ({ changes: 1 }))
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('FROM settings')) return { get: vi.fn(() => ({ value: '0' })) }
        if (sql.includes("state = 'composing'")) {
          return {
            get: vi.fn(() => ({
              id: 'draft-1',
              state: 'composing',
              kind: 'new',
              to_json: JSON.stringify([{ name: '', email: 'to@example.com' }]),
              cc_json: '[]',
              bcc_json: '[]',
              subject: 'Message ID',
              updated_at: 1,
              gmail_draft_id: null,
              rfc_message_id: null,
              send_at: null,
              attempts: 4,
              verify_attempts: 5,
              last_error: null
            })),
            run
          }
        }
        throw new Error(`unexpected SQL: ${sql}`)
      })
    } as unknown as Db

    expect(queueSend(db, 'me@workspace.example', 'draft-1', 1_000)).toEqual({ id: 'draft-1', sendAt: 1_000 })
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/^<[0-9a-f-]+@workspace\.example>$/),
      1_000,
      1_000,
      'me@workspace.example',
      'draft-1'
    )
    const updateSql = (db.prepare as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.startsWith('UPDATE outbox'))
    expect(updateSql).toContain('verify_attempts = 0')
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
