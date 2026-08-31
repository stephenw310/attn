import { describe, expect, it } from 'vitest'
import { readAppSettings, writeAppSetting } from './appSettings'
import { openDatabase } from './db'
import { undoSendDelayMs } from './outbox/queue'
import { readSetting } from './settings'

describe('app settings storage', () => {
  it('returns the documented defaults on a fresh store', () => {
    const db = openDatabase(':memory:')
    expect(readAppSettings(db)).toEqual({
      undoSendDelaySeconds: 5,
      autoAdvanceDirection: 'next',
      launchAtLogin: true,
      menuBarIcon: false,
      notificationsPausedUntil: null
    })
  })

  it('persists valid writes and feeds the same value the outbox sender reads', () => {
    const db = openDatabase(':memory:')
    const updated = writeAppSetting(db, 'undoSendDelaySeconds', 20)
    expect(updated.undoSendDelaySeconds).toBe(20)
    // The sender's own resolver sees the write — no second literal list.
    expect(undoSendDelayMs(db)).toBe(20_000)

    expect(writeAppSetting(db, 'autoAdvanceDirection', 'previous').autoAdvanceDirection).toBe('previous')
    expect(writeAppSetting(db, 'launchAtLogin', false).launchAtLogin).toBe(false)
    expect(writeAppSetting(db, 'menuBarIcon', true).menuBarIcon).toBe(true)
    expect(writeAppSetting(db, 'notificationsPausedUntil', 4_000).notificationsPausedUntil).toBe(4_000)
    expect(writeAppSetting(db, 'notificationsPausedUntil', null).notificationsPausedUntil).toBeNull()
  })

  it('rejects values outside the allowlist without touching the store', () => {
    const db = openDatabase(':memory:')
    expect(() => writeAppSetting(db, 'undoSendDelaySeconds', 7)).toThrow('invalid undo-send delay')
    expect(() => writeAppSetting(db, 'theme', 'sand')).toThrow('unknown setting')
    expect(readAppSettings(db)).toEqual(readAppSettings(openDatabase(':memory:')))
  })

  it('stores a default-valued write as an absent row rather than a literal', () => {
    const db = openDatabase(':memory:')
    writeAppSetting(db, 'autoAdvanceDirection', 'previous')
    writeAppSetting(db, 'autoAdvanceDirection', 'next')
    expect(readSetting(db, 'autoAdvanceDirection')).toBeUndefined()
    expect(readAppSettings(db).autoAdvanceDirection).toBe('next')
  })

  it('treats a corrupt stored direction as the default', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO settings (account_id, key, value) VALUES ('__app__', ?, ?)").run(
      'autoAdvanceDirection',
      'sideways'
    )
    expect(readAppSettings(db).autoAdvanceDirection).toBe('next')
  })
})
