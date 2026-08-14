// Local store. Plain Node module: Electron ownership stays at the composition edge.

import Database from 'better-sqlite3'
import { CURRENT_SCHEMA, CURRENT_SCHEMA_VERSION } from './schema'

export type Db = Database.Database

export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initializeSchema(db)
  return db
}

function initializeSchema(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current === CURRENT_SCHEMA_VERSION) return
  if (current !== 0) {
    throw new Error(
      `Unsupported local schema v${current}; delete the Attn profile and sync again (expected v${CURRENT_SCHEMA_VERSION})`
    )
  }
  db.transaction(() => {
    db.exec(CURRENT_SCHEMA)
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
  })()
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}
