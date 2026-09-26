import type Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, MINIMUM_MIGRATABLE_SCHEMA_VERSION } from './schema'

type Db = Database.Database

export interface SchemaMigration {
  from: number
  to: number
  sql: string
}

// Ordered, immutable history. Never edit a shipped step. Add one new step for
// every schema bump so an installation can skip application versions and still
// reach the current snapshot.
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    from: 21,
    to: 22,
    sql: `
      CREATE TABLE thread_mailboxes (
        account_id TEXT NOT NULL,
        view       TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        sort_at    INTEGER NOT NULL,
        PRIMARY KEY (account_id, thread_id, view)
      );
      CREATE INDEX idx_thread_mailboxes_recent
        ON thread_mailboxes (account_id, view, sort_at DESC, thread_id);

      ALTER TABLE sync_state ADD COLUMN mailbox_cursor TEXT;

      ALTER TABLE message_fts_map ADD COLUMN internal_date INTEGER;
      CREATE INDEX idx_message_fts_map_recent
        ON message_fts_map (account_id, internal_date DESC, fts_rowid);

      UPDATE message_fts_map
      SET internal_date = (
        SELECT messages.internal_date
        FROM messages
        WHERE messages.account_id = message_fts_map.account_id
          AND messages.id = message_fts_map.message_id
      );
    `
  },
  {
    from: 22,
    to: 23,
    sql: `
      CREATE TABLE snippets (
        account_id TEXT NOT NULL,
        id         TEXT NOT NULL,
        name       TEXT NOT NULL,
        trigger    TEXT,
        subject    TEXT,
        body_html  TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, id)
      );
      CREATE UNIQUE INDEX idx_snippets_trigger
        ON snippets (account_id, trigger) WHERE trigger IS NOT NULL;
      ALTER TABLE outbox DROP COLUMN remote_updated_at;
    `
  },
  {
    from: 23,
    to: 24,
    sql: `
      ALTER TABLE outbox ADD COLUMN follow_up_at INTEGER;
      ALTER TABLE reminders ADD COLUMN origin_message_id TEXT;
      ALTER TABLE reminders ADD COLUMN origin_rfc_message_id TEXT;
      ALTER TABLE reminders ADD COLUMN origin_internal_date INTEGER;
    `
  },
  {
    from: 24,
    to: 25,
    sql: `
      ALTER TABLE reminders ADD COLUMN origin_outbox_created_at INTEGER;
      UPDATE reminders
      SET origin_outbox_created_at = (
        SELECT MAX(outbox.created_at)
        FROM outbox
        WHERE outbox.account_id = reminders.account_id
          AND outbox.rfc_message_id = reminders.origin_rfc_message_id
      )
      WHERE kind = 'follow_up' AND origin_rfc_message_id IS NOT NULL;
    `
  },
  {
    from: 25,
    to: 26,
    sql: 'ALTER TABLE sync_state DROP COLUMN sweep_threads_total;'
  },
  {
    from: 26,
    to: 27,
    sql: 'ALTER TABLE accounts DROP COLUMN created_at;'
  },
  {
    from: 27,
    to: 28,
    sql: `
      CREATE TABLE split_judgments (
        account_id       TEXT NOT NULL,
        thread_id        TEXT NOT NULL,
        split_id         TEXT NOT NULL,
        description_hash TEXT NOT NULL,
        evidence_key     TEXT NOT NULL,
        probability      REAL NOT NULL,
        judged_at        INTEGER NOT NULL,
        PRIMARY KEY (account_id, thread_id, split_id)
      );
    `
  },
  {
    from: 28,
    to: 29,
    sql: 'ALTER TABLE split_rules ADD COLUMN description TEXT;'
  },
  {
    from: 29,
    to: 30,
    sql: 'ALTER TABLE outbox ADD COLUMN sender_email TEXT;'
  }
]

/**
 * Validate and return the exact migration path. This runs in production as
 * well as tests so malformed release code fails before it changes the store.
 */
export function migrationPath(from: number, to = CURRENT_SCHEMA_VERSION): readonly SchemaMigration[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new Error(`Invalid schema migration range v${from} to v${to}`)
  }
  if (from < MINIMUM_MIGRATABLE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported local schema v${from}; this build can migrate v${MINIMUM_MIGRATABLE_SCHEMA_VERSION} through v${CURRENT_SCHEMA_VERSION}`
    )
  }
  const path: SchemaMigration[] = []
  let version = from
  while (version < to) {
    const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.from === version)
    if (!migration || migration.to !== version + 1) {
      throw new Error(`Missing schema migration v${version} to v${version + 1}`)
    }
    path.push(migration)
    version = migration.to
  }
  return path
}

export function validateMigrationRegistry(): void {
  const path = migrationPath(MINIMUM_MIGRATABLE_SCHEMA_VERSION)
  if (path.length !== SCHEMA_MIGRATIONS.length) {
    throw new Error('Schema migration registry contains a duplicate or unreachable step')
  }
}

/** Upgrade one existing profile atomically. Fresh profiles use CURRENT_SCHEMA. */
export function migrateSchema(db: Db, from: number, to = CURRENT_SCHEMA_VERSION): void {
  const path = migrationPath(from, to)
  if (path.length === 0) return
  db.transaction(() => {
    for (const migration of path) {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.to}`)
    }
    const check = db.pragma('quick_check', { simple: true }) as string
    if (check !== 'ok') throw new Error(`Schema migration integrity check failed: ${check}`)
  })()
}
