import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { queueSend, undoSendDelayMs } from './queue'

function settingsDb(value: string | undefined): Db {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(() => (value === undefined ? undefined : { value })) }))
  } as unknown as Db
}

function queueDb(): { db: Db; run: ReturnType<typeof vi.fn> } {
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
  return { db, run }
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
    const { db, run } = queueDb()

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

  it('refuses to derive a Message-ID domain from an account id without an @', () => {
    const { db, run } = queueDb()

    expect(() => queueSend(db, 'missing-domain', 'draft-1', 1_000)).toThrow(
      'sender account is missing a Message-ID domain'
    )
    expect(run).not.toHaveBeenCalled()
  })
})
