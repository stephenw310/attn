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
