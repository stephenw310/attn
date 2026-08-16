import { describe, expect, it } from 'vitest'
import type { Db } from '../db'
import { replaySnoozeReminderDelta, type SnoozeReminderSnapshot } from './reminders'

/** Models just the label and reminder reads/writes the replay touches. */
function fakeDb(labels: Set<string>, reminder: SnoozeReminderSnapshot | null): Db {
  return {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.startsWith('INSERT OR IGNORE INTO thread_labels')) labels.add(String(args[2]))
        else if (sql.startsWith('DELETE FROM thread_labels') && sql.includes('label_id = ?')) {
          labels.delete(String(args[2]))
        }
        return { changes: 1 }
      },
      get: () => (sql.includes('FROM reminders') ? (reminder ?? undefined) : undefined),
      all: () => []
    }),
    transaction: (callback: () => unknown) => callback
  } as unknown as Db
}

describe('snooze reminder replay', () => {
  it('hides a thread whose snooze is still pending', () => {
    const labels = new Set(['INBOX'])
    replaySnoozeReminderDelta(fakeDb(labels, { dueAt: 20_000, state: 'pending' }), 'a@example.com', 't1')
    expect(labels.has('INBOX')).toBe(false)
  })

  it('leaves a returned reminder alone so Gmail stays authoritative over labels', () => {
    // The reminder stays 'returned' until the user handles the thread in Attn,
    // so treating it as a label authority would re-add INBOX on every sync and
    // permanently override an archive performed in Gmail elsewhere.
    const labels = new Set<string>()
    replaySnoozeReminderDelta(fakeDb(labels, { dueAt: 10_000, state: 'returned' }), 'a@example.com', 't1')
    expect(labels.has('INBOX')).toBe(false)
  })

  it('leaves a thread with no reminder untouched', () => {
    const labels = new Set(['INBOX'])
    replaySnoozeReminderDelta(fakeDb(labels, null), 'a@example.com', 't1')
    expect([...labels]).toEqual(['INBOX'])
  })
})
