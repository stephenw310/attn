import { describe, expect, it } from 'vitest'
import { readAppSettings, writeAppSetting } from './appSettings'
import { openDatabase } from './db'
import { undoSendDelayMs } from './outbox/queue'
import { readSetting } from './settings'

describe('app settings storage', () => {
  it('returns the documented defaults on a fresh store', () => {
    const db = openDatabase(':memory:')
    expect(readAppSettings(db)).toEqual({
      palette: 'matcha',
      undoSendDelaySeconds: 5,
      autoAdvanceDirection: 'next',
      launchAtLogin: true,
      menuBarIcon: false,
      unreadBadgeEnabled: true,
      notificationsPausedUntil: null,
      remoteImagesBlocked: false
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
    expect(writeAppSetting(db, 'unreadBadgeEnabled', false).unreadBadgeEnabled).toBe(false)
    expect(writeAppSetting(db, 'notificationsPausedUntil', 4_000).notificationsPausedUntil).toBe(4_000)
    expect(writeAppSetting(db, 'notificationsPausedUntil', null).notificationsPausedUntil).toBeNull()
    // T33: the toggle rides the documented `remoteImages` row.
    expect(writeAppSetting(db, 'remoteImagesBlocked', true).remoteImagesBlocked).toBe(true)
    expect(readSetting(db, 'remoteImages')).toBe('blocked')
    expect(writeAppSetting(db, 'remoteImagesBlocked', false).remoteImagesBlocked).toBe(false)
    expect(readSetting(db, 'remoteImages')).toBeUndefined()
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

it('preserves appearance while persisting palettes and rejects invalid values', () => {
  const db = openDatabase(':memory:')
  try {
    db.prepare(
      "INSERT INTO settings (account_id, key, value) VALUES ('__app__', 'theme', 'dispatch-light')"
    ).run()
    for (const palette of ['mist', 'linen', 'dusk', 'matcha']) {
      expect(writeAppSetting(db, 'palette', palette).palette).toBe(palette)
      expect(readAppSettings(db).palette).toBe(palette)
      expect(readSetting(db, 'theme')).toBe('dispatch-light')
    }
    expect(() => writeAppSetting(db, 'palette', 'neon')).toThrow('invalid palette')
    expect(readAppSettings(db).palette).toBe('matcha')
    db.prepare("INSERT INTO settings (account_id, key, value) VALUES ('__app__', 'palette', 'unknown')").run()
    expect(readAppSettings(db).palette).toBe('matcha')
  } finally {
    db.close()
  }
})
