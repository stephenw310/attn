// Local store. Plain Node module — no Electron imports — so it can move
// into the sync utility process at M1 without changes (SPEC §6).

import Database from 'better-sqlite3'
import { migrations } from './migrations'

export type Db = Database.Database

export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < migrations.length; v++) {
    const apply = db.transaction(() => {
      db.exec(migrations[v])
      db.pragma(`user_version = ${v + 1}`)
    })
    apply()
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}
