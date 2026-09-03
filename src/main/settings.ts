import type { Db } from './db'

export const APP_SETTINGS_ACCOUNT_ID = '__app__'

export function readAccountSetting(db: Db, accountId: string, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE account_id = ? AND key = ?').get(accountId, key) as
    | { value: string }
    | undefined
  return row?.value
}

export function writeAccountSetting(db: Db, accountId: string, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(
    accountId,
    key,
    value
  )
}

export function readSetting(db: Db, key: string): string | undefined {
  return readAccountSetting(db, APP_SETTINGS_ACCOUNT_ID, key)
}

export function writeSetting(db: Db, key: string, value: string): void {
  writeAccountSetting(db, APP_SETTINGS_ACCOUNT_ID, key, value)
}

export function deleteAccountSetting(db: Db, accountId: string, key: string): void {
  db.prepare('DELETE FROM settings WHERE account_id = ? AND key = ?').run(accountId, key)
}

export function deleteSetting(db: Db, key: string): void {
  deleteAccountSetting(db, APP_SETTINGS_ACCOUNT_ID, key)
}

export function settingEnabled(db: Db, key: string, defaultValue: boolean): boolean {
  const value = readSetting(db, key)
  return value === undefined ? defaultValue : value === 'true'
}

/** One app-global row read and written as a typed value. */
export interface TypedSetting<T> {
  read: (db: Db) => T
  write: (db: Db, value: T) => void
}

/**
 * Bind one app-global key to a typed value with a default. The default is not
 * stored — writing it deletes the row, so an absent row always means "the
 * default" and the table holds explicit choices only. An unparseable stored
 * value reads as the default rather than throwing: a settings row must never
 * be able to break a snapshot read.
 */
export function typedSetting<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T | undefined,
  format: (value: T) => string = String
): TypedSetting<T> {
  return {
    read: (db) => {
      const raw = readSetting(db, key)
      return raw === undefined ? defaultValue : (parse(raw) ?? defaultValue)
    },
    write: (db, value) => {
      if (value === defaultValue) deleteSetting(db, key)
      else writeSetting(db, key, format(value))
    }
  }
}
