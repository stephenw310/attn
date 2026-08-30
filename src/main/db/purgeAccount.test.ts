import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from './index'
import { accountKeyedTables, purgeAccountRows } from './purgeAccount'

const REMOVED = 'removed@attn.test'
const SURVIVOR = 'survivor@attn.test'

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

/**
 * Seed one row per account into every account-keyed table, deriving the
 * insert from the live schema. This is the leak guard A6 asks for: a future
 * account-keyed table lands here automatically, and if its constraints defeat
 * the generic filler the test fails loudly instead of silently skipping it.
 */
function seedEveryAccountTable(db: Db, accountId: string): void {
  for (const table of accountKeyedTables(db)) {
    if (table === 'message_fts') {
      const inserted = db
        .prepare(
          `INSERT INTO message_fts (account_id, subject, sender, recipients, body, filenames)
           VALUES (?, 's', 's', 's', 'b', 'f')`
        )
        .run(accountId)
      db.prepare(
        'INSERT OR REPLACE INTO message_fts_map (account_id, message_id, thread_id, fts_rowid) VALUES (?, ?, ?, ?)'
      ).run(accountId, `${accountId}-fts-msg`, `${accountId}-fts-thread`, Number(inserted.lastInsertRowid))
      continue
    }
    if (table === 'message_fts_map') continue // seeded beside message_fts above
    const columns = db.pragma(`table_info('${table}')`) as ColumnInfo[]
    const filled = columns.filter(
      (column) =>
        column.name === 'account_id' ||
        ((column.notnull === 1 || column.pk > 0) && column.dflt_value === null && !isRowidAlias(column))
    )
    const values = filled.map((column) => {
      if (column.name === 'account_id') return accountId
      const affinity = column.type.toUpperCase()
      if (affinity.includes('INT') || affinity.includes('REAL')) return 1
      return `${accountId}-${column.name}`
    })
    const placeholders = filled.map(() => '?').join(', ')
    db.prepare(
      `INSERT INTO "${table}" (${filled.map((column) => `"${column.name}"`).join(', ')})
       VALUES (${placeholders})`
    ).run(...values)
  }
  db.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(
    accountId,
    accountId
  )
  db.prepare(
    "INSERT OR REPLACE INTO settings (account_id, key, value) VALUES ('__app__', 'theme', 'dark')"
  ).run()
}

function isRowidAlias(column: ColumnInfo): boolean {
  return column.pk === 1 && column.type.toUpperCase() === 'INTEGER'
}

function countRows(db: Db, table: string, accountId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE account_id = ?`).get(accountId) as {
      count: number
    }
  ).count
}

describe('purgeAccountRows', () => {
  it('discovers every account-keyed table from the live schema', () => {
    const db = openDatabase(':memory:')
    const tables = accountKeyedTables(db)
    // Spot-check the load-bearing members; the full set is schema-derived.
    for (const expected of ['threads', 'messages', 'outbox', 'action_queue', 'reminders', 'settings']) {
      expect(tables).toContain(expected)
    }
    expect(tables).toContain('message_fts')
    db.close()
  })

  it('removes every trace of one account and nothing of any other', () => {
    const db = openDatabase(':memory:')
    seedEveryAccountTable(db, REMOVED)
    seedEveryAccountTable(db, SURVIVOR)
    const tables = accountKeyedTables(db)
    // The guard half: the seeding above actually produced a row to purge in
    // *every* account-keyed table, so nothing can pass vacuously.
    for (const table of tables) {
      expect(countRows(db, table, REMOVED), `${table} must be seeded`).toBeGreaterThan(0)
    }

    const result = purgeAccountRows(db, REMOVED)
    expect(result.tables).toEqual(tables)
    expect(result.outboxSpoolIds).toEqual([`${REMOVED}-id`])

    for (const table of tables) {
      expect(countRows(db, table, REMOVED), `${table} must be purged`).toBe(0)
      expect(countRows(db, table, SURVIVOR), `${table} must keep the survivor`).toBeGreaterThan(0)
    }
    // The roster row goes with the data; the survivor's stays.
    expect(db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id = ?').get(REMOVED)).toEqual({
      count: 0
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id = ?').get(SURVIVOR)).toEqual({
      count: 1
    })
    // App-level settings are not the account's and survive removal (F18).
    expect(
      db.prepare("SELECT value FROM settings WHERE account_id = '__app__' AND key = 'theme'").get()
    ).toEqual({ value: 'dark' })
    db.close()
  })
})
