// Local store. Plain Node module: Electron ownership stays at the composition edge.

import Database from 'better-sqlite3'
import { migrateSchema, validateMigrationRegistry } from './migrations'
import { CURRENT_SCHEMA, CURRENT_SCHEMA_VERSION } from './schema'

export type Db = Database.Database

export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initializeSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function initializeSchema(db: Db): void {
  validateMigrationRegistry()
  const current = db.pragma('user_version', { simple: true }) as number
  if (current === CURRENT_SCHEMA_VERSION) return
  if (current === 0) {
    db.transaction(() => {
      db.exec(CURRENT_SCHEMA)
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
    })()
    return
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Local schema v${current} is newer than this Attn build (v${CURRENT_SCHEMA_VERSION}); install a newer build`
    )
  }
  migrateSchema(db, current)
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}
