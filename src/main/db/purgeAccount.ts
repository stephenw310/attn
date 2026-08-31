import { removeAccountFromIndex } from '../sync/fts'
import type { Db } from './index'

/**
 * Every live table carrying an `account_id` column, read from the schema
 * itself rather than a hand-list that rots: a future account-keyed table is
 * covered the day it is created (F18 remove-account, M5 A6). The FTS virtual
 * table appears here too — its rows are removed through the rowid map, not
 * the generic delete below.
 */
export function accountKeyedTables(db: Db): string[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as { name: string }[]
  return tables
    .map((table) => table.name)
    .filter((name) => {
      const columns = db.pragma(`table_info('${name.replaceAll("'", "''")}')`) as { name: string }[]
      return columns.some((column) => column.name === 'account_id')
    })
}

export interface AccountPurgeResult {
  /** The account-keyed tables the purge visited (unit-test guard surface). */
  tables: string[]
  /** Outbox ids owned by the account at the time of the purge. */
  outboxSpoolIds: string[]
}

export function accountOutboxSpoolIds(db: Db, accountId: string): string[] {
  return (db.prepare('SELECT id FROM outbox WHERE account_id = ?').all(accountId) as { id: string }[]).map(
    (row) => row.id
  )
}

/**
 * Remove every local trace of one account in a single transaction: rows in
 * every account-keyed table, the FTS index entries, and the roster row in
 * `accounts` itself. Deliberately excluded: `__app__` settings (they are not
 * the account's) and the spool files on disk — SQLite cannot delete those, so
 * the caller must await their deletion before purging the identifying rows (SPEC F18, D3).
 */
export function purgeAccountRows(db: Db, accountId: string): AccountPurgeResult {
  const tables = accountKeyedTables(db)
  const outboxSpoolIds = accountOutboxSpoolIds(db, accountId)
  db.transaction(() => {
    removeAccountFromIndex(db, accountId)
    for (const table of tables) {
      if (table === 'message_fts') continue
      db.prepare(`DELETE FROM "${table}" WHERE account_id = ?`).run(accountId)
    }
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId)
  })()
  return { tables, outboxSpoolIds }
}
