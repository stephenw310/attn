import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from './index'
import { migrateSchema, migrationPath, SCHEMA_MIGRATIONS } from './migrations'
import { CURRENT_SCHEMA_VERSION, MINIMUM_MIGRATABLE_SCHEMA_VERSION } from './schema'

it('applies the documented v21 upgrade with the current mailbox keys and preserved message dates', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    // Only the v21 tables touched by this additive operator procedure are needed.
    db.exec(`
      CREATE TABLE sync_state (account_id TEXT PRIMARY KEY);
      CREATE TABLE messages (
        account_id TEXT NOT NULL, id TEXT NOT NULL, internal_date INTEGER,
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE message_fts_map (
        account_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        fts_rowid INTEGER NOT NULL, PRIMARY KEY (account_id, message_id)
      );
      INSERT INTO sync_state VALUES ('account');
      INSERT INTO messages VALUES ('account', 'message', 123), ('other', 'message', 456);
      INSERT INTO message_fts_map VALUES ('account', 'message', 'thread', 1),
                                        ('other', 'message', 'thread', 2);
      PRAGMA user_version = 21;
    `)
    migrateSchema(db, 21, 22)

    expect(db.pragma('user_version', { simple: true })).toBe(22)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(thread_mailboxes)')).toEqual(fresh.pragma('table_info(thread_mailboxes)'))
    for (const index of ['idx_thread_mailboxes_recent', 'idx_message_fts_map_recent']) {
      expect(db.pragma(`index_xinfo(${index})`)).toEqual(fresh.pragma(`index_xinfo(${index})`))
    }
    expect(db.prepare('SELECT * FROM sync_state').all()).toEqual([
      { account_id: 'account', mailbox_cursor: null }
    ])
    expect(
      db.prepare('SELECT account_id, internal_date FROM message_fts_map ORDER BY account_id').all()
    ).toEqual([
      { account_id: 'account', internal_date: 123 },
      { account_id: 'other', internal_date: 456 }
    ])
    const plan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM thread_mailboxes WHERE account_id = ? AND thread_id = ?')
      .all('account', 'thread') as { detail: string }[]
    expect(plan.map((row) => row.detail).join('\n')).toContain('(account_id=? AND thread_id=?)')
  } finally {
    db.close()
    fresh.close()
  }
})

it('applies the documented T34 v22 → 23 upgrade: snippets added, outbox.remote_updated_at dropped', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    // Only the v22 table the procedure touches; the row proves the drop keeps
    // every other column's data.
    db.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
        remote_updated_at INTEGER, remote_fingerprint TEXT
      );
      INSERT INTO outbox VALUES ('o1', 'account', 99, 'fp');
      PRAGMA user_version = 22;
    `)
    migrateSchema(db, 22, 23)

    expect(db.pragma('user_version', { simple: true })).toBe(23)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(snippets)')).toEqual(fresh.pragma('table_info(snippets)'))
    expect(db.pragma('index_xinfo(idx_snippets_trigger)')).toEqual(
      fresh.pragma('index_xinfo(idx_snippets_trigger)')
    )
    const outboxColumns = (db.pragma('table_info(outbox)') as { name: string }[]).map((row) => row.name)
    expect(outboxColumns).not.toContain('remote_updated_at')
    expect(db.prepare('SELECT * FROM outbox').all()).toEqual([
      { id: 'o1', account_id: 'account', remote_fingerprint: 'fp' }
    ])
  } finally {
    db.close()
    fresh.close()
  }
})

it('applies the documented T35 v23 → 24 upgrade: follow-up deadline and reminder origin columns', () => {
  const db = new Database(':memory:')
  try {
    // Only the v23 tables the additive procedure touches; the rows prove
    // existing snoozes and drafts survive with the new columns NULL.
    db.exec(`
      CREATE TABLE outbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
      CREATE TABLE reminders (
        account_id TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'snooze',
        due_at     INTEGER NOT NULL,
        state      TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (account_id, thread_id, kind)
      );
      INSERT INTO outbox VALUES ('o1', 'account');
      INSERT INTO reminders VALUES ('account', 't1', 'snooze', 123, 'pending');
      PRAGMA user_version = 23;
    `)
    migrateSchema(db, 23, 24)

    expect(db.pragma('user_version', { simple: true })).toBe(24)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    for (const column of ['origin_message_id', 'origin_rfc_message_id', 'origin_internal_date']) {
      expect((db.pragma('table_info(reminders)') as { name: string }[]).map((row) => row.name)).toContain(
        column
      )
    }
    expect((db.pragma('table_info(outbox)') as { name: string }[]).map((row) => row.name)).toContain(
      'follow_up_at'
    )
    expect(db.prepare('SELECT * FROM reminders').all()).toEqual([
      {
        account_id: 'account',
        thread_id: 't1',
        kind: 'snooze',
        due_at: 123,
        state: 'pending',
        origin_message_id: null,
        origin_rfc_message_id: null,
        origin_internal_date: null
      }
    ])
  } finally {
    db.close()
  }
})

it('applies the documented v24 → 25 upgrade and backfills durable follow-up ordering', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    db.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        rfc_message_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE reminders (
        account_id TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'snooze',
        due_at     INTEGER NOT NULL,
        state      TEXT NOT NULL DEFAULT 'pending',
        origin_message_id TEXT,
        origin_rfc_message_id TEXT,
        origin_internal_date INTEGER,
        PRIMARY KEY (account_id, thread_id, kind)
      );
      INSERT INTO outbox VALUES ('o1', 'account', '<origin@example.test>', 456);
      INSERT INTO reminders VALUES (
        'account', 't1', 'follow_up', 123, 'done', 'm1', '<origin@example.test>', 321
      );
      INSERT INTO reminders VALUES ('account', 't2', 'snooze', 789, 'pending', NULL, NULL, NULL);
      PRAGMA user_version = 24;
    `)
    migrateSchema(db, 24, 25)

    expect(db.pragma('user_version', { simple: true })).toBe(25)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(reminders)')).toEqual(fresh.pragma('table_info(reminders)'))
    expect(
      db.prepare('SELECT thread_id, origin_outbox_created_at FROM reminders ORDER BY thread_id').all()
    ).toEqual([
      { thread_id: 't1', origin_outbox_created_at: 456 },
      { thread_id: 't2', origin_outbox_created_at: null }
    ])
  } finally {
    db.close()
    fresh.close()
  }
})

it('applies the PR #108 v26 → 27 cleanup without changing account rows', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('primary', 'primary@example.test', 123);
      INSERT INTO accounts VALUES ('secondary', 'secondary@example.test', 456);
      PRAGMA user_version = 26;
    `)
    migrateSchema(db, 26, 27)

    expect(db.pragma('user_version', { simple: true })).toBe(27)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(accounts)')).toEqual(fresh.pragma('table_info(accounts)'))
    expect(db.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual([
      { id: 'primary', email: 'primary@example.test' },
      { id: 'secondary', email: 'secondary@example.test' }
    ])
  } finally {
    db.close()
    fresh.close()
  }
})

it('applies the v25 → 26 cleanup without changing sync state rows', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE sync_state (
        account_id TEXT PRIMARY KEY,
        sweep_threads_total INTEGER,
        fts_cursor TEXT
      );
      INSERT INTO sync_state VALUES ('primary', 123, 'done');
      PRAGMA user_version = 25;
    `)
    migrateSchema(db, 25, 26)

    expect(db.pragma('user_version', { simple: true })).toBe(26)
    expect((db.pragma('table_info(sync_state)') as { name: string }[]).map((row) => row.name)).toEqual([
      'account_id',
      'fts_cursor'
    ])
    expect(db.prepare('SELECT * FROM sync_state').all()).toEqual([
      { account_id: 'primary', fts_cursor: 'done' }
    ])
  } finally {
    db.close()
  }
})

it('applies the v27 → 28 upgrade: split judgments added, split rules untouched', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    // Only the v27 table a described split reads beside the new one; its row
    // proves the additive step keeps every configured rule.
    db.exec(`
      CREATE TABLE split_rules (
        account_id TEXT NOT NULL,
        id         TEXT NOT NULL,
        position   INTEGER NOT NULL,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        match_json TEXT NOT NULL,
        notify     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, id)
      );
      INSERT INTO split_rules
      VALUES ('account', 'preset:github', 1, 'GitHub', 'preset',
              '{"version":1,"operator":"any","conditions":[{"type":"senderDomain","value":"github.com"}]}', 0);
      PRAGMA user_version = 27;
    `)
    migrateSchema(db, 27, 28)

    expect(db.pragma('user_version', { simple: true })).toBe(28)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(split_judgments)')).toEqual(fresh.pragma('table_info(split_judgments)'))
    expect(db.prepare('SELECT COUNT(*) AS count FROM split_judgments').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT id, name, notify FROM split_rules').all()).toEqual([
      { id: 'preset:github', name: 'GitHub', notify: 0 }
    ])
    // The judgment key is (account, thread, split): one answer per split per thread.
    db.prepare(
      `INSERT INTO split_judgments
       (account_id, thread_id, split_id, description_hash, evidence_key, probability, judged_at)
       VALUES ('account', 'thread', 'custom:1', 'hash', 'message', 0.9, 10)`
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO split_judgments
           (account_id, thread_id, split_id, description_hash, evidence_key, probability, judged_at)
           VALUES ('account', 'thread', 'custom:1', 'other', 'message-2', 0.1, 20)`
        )
        .run()
    ).toThrow('UNIQUE constraint failed')
  } finally {
    db.close()
    fresh.close()
  }
})

it('applies the v28 → 29 upgrade: split rules gain a description and keep their rows', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    // The v28 shape of the one table the additive procedure touches.
    db.exec(`
      CREATE TABLE split_rules (
        account_id TEXT NOT NULL,
        id         TEXT NOT NULL,
        position   INTEGER NOT NULL,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        match_json TEXT NOT NULL DEFAULT '{"version":1,"operator":"any","conditions":[]}',
        notify     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, id)
      );
      INSERT INTO split_rules
      VALUES ('account', 'custom:1', 0, 'Landlord', 'custom',
              '{"version":1,"operator":"any","conditions":[{"type":"senderDomain","value":"landlord.test"}]}', 1);
      PRAGMA user_version = 28;
    `)
    migrateSchema(db, 28, 29)

    expect(db.pragma('user_version', { simple: true })).toBe(29)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.pragma('table_info(split_rules)')).toEqual(fresh.pragma('table_info(split_rules)'))
    // An upgraded rule keeps its conditions and reads as rule-based.
    expect(db.prepare('SELECT id, name, notify, description FROM split_rules').all()).toEqual([
      { id: 'custom:1', name: 'Landlord', notify: 1, description: null }
    ])
  } finally {
    db.close()
    fresh.close()
  }
})

it('openDatabase migrates an existing profile before returning it', () => {
  const root = mkdtempSync(join(tmpdir(), 'attn-schema-upgrade-'))
  const path = join(root, 'attn.db')
  try {
    const old = openDatabase(path)
    old.exec(`
      ALTER TABLE outbox DROP COLUMN sender_email;
      ALTER TABLE split_rules DROP COLUMN description;
      DROP TABLE split_judgments;
      ALTER TABLE accounts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      INSERT INTO accounts (id, email, created_at) VALUES ('account', 'person@example.test', 123);
      PRAGMA user_version = 26;
    `)
    old.close()

    const upgraded = openDatabase(path)
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
      expect(upgraded.prepare('SELECT * FROM accounts').get()).toEqual({
        id: 'account',
        email: 'person@example.test'
      })
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps a contiguous migration path through the current schema', () => {
  expect(SCHEMA_MIGRATIONS).toHaveLength(CURRENT_SCHEMA_VERSION - MINIMUM_MIGRATABLE_SCHEMA_VERSION)
  expect(SCHEMA_MIGRATIONS[0]?.from).toBe(MINIMUM_MIGRATABLE_SCHEMA_VERSION)
  expect(SCHEMA_MIGRATIONS.at(-1)?.to).toBe(CURRENT_SCHEMA_VERSION)
  expect(migrationPath(MINIMUM_MIGRATABLE_SCHEMA_VERSION)).toHaveLength(
    CURRENT_SCHEMA_VERSION - MINIMUM_MIGRATABLE_SCHEMA_VERSION
  )
})

it('upgrades a populated v21 profile through every retained migration', () => {
  const db = openDatabase(':memory:')
  try {
    // Reverse only the recorded v21..v28 changes to build a complete v21
    // profile from the authoritative current snapshot.
    db.exec(`
      ALTER TABLE outbox DROP COLUMN sender_email;
      ALTER TABLE split_rules DROP COLUMN description;
      DROP TABLE split_judgments;
      DROP TABLE thread_mailboxes;
      DROP INDEX idx_message_fts_map_recent;
      ALTER TABLE message_fts_map DROP COLUMN internal_date;
      ALTER TABLE sync_state DROP COLUMN mailbox_cursor;
      DROP TABLE snippets;
      ALTER TABLE outbox ADD COLUMN remote_updated_at INTEGER;
      ALTER TABLE outbox DROP COLUMN follow_up_at;
      ALTER TABLE reminders DROP COLUMN origin_outbox_created_at;
      ALTER TABLE reminders DROP COLUMN origin_internal_date;
      ALTER TABLE reminders DROP COLUMN origin_rfc_message_id;
      ALTER TABLE reminders DROP COLUMN origin_message_id;
      ALTER TABLE sync_state ADD COLUMN sweep_threads_total INTEGER;
      ALTER TABLE accounts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

      INSERT INTO accounts (id, email, created_at)
      VALUES ('account', 'person@example.test', 123);
      INSERT INTO sync_state (account_id, sweep_threads_total)
      VALUES ('account', 456);
      INSERT INTO messages (account_id, id, thread_id, internal_date)
      VALUES ('account', 'message', 'thread', 789);
      INSERT INTO message_fts_map (account_id, message_id, thread_id, fts_rowid)
      VALUES ('account', 'message', 'thread', 1);
      INSERT INTO outbox (id, account_id, created_at, updated_at, remote_updated_at)
      VALUES ('outbox', 'account', 100, 200, 300);
      INSERT INTO reminders (account_id, thread_id, kind, due_at)
      VALUES ('account', 'thread', 'snooze', 400);
      INSERT INTO split_rules (account_id, id, position, name, kind, notify)
      VALUES ('account', 'custom:1', 0, 'Landlord', 'custom', 1);
      PRAGMA user_version = 21;
    `)

    migrateSchema(db, 21)

    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.prepare('SELECT * FROM accounts').get()).toEqual({
      id: 'account',
      email: 'person@example.test'
    })
    expect(db.prepare('SELECT internal_date FROM message_fts_map').get()).toEqual({
      internal_date: 789
    })
    expect(db.prepare('SELECT mailbox_cursor FROM sync_state').get()).toEqual({ mailbox_cursor: null })
    expect(db.prepare('SELECT follow_up_at FROM outbox').get()).toEqual({ follow_up_at: null })
    expect(db.prepare('SELECT origin_message_id FROM reminders').get()).toEqual({
      origin_message_id: null
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM split_judgments').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT id, name, description FROM split_rules').all()).toEqual([
      { id: 'custom:1', name: 'Landlord', description: null }
    ])
  } finally {
    db.close()
  }
})

it('rolls the whole skipped-version path back when a later migration fails', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE sync_state (
        account_id TEXT PRIMARY KEY,
        sweep_threads_total INTEGER
      );
      INSERT INTO sync_state VALUES ('primary', 123);
      PRAGMA user_version = 25;
    `)

    expect(() => migrateSchema(db, 25, 27)).toThrow('no such table: accounts')
    expect(db.pragma('user_version', { simple: true })).toBe(25)
    expect((db.pragma('table_info(sync_state)') as { name: string }[]).map((row) => row.name)).toContain(
      'sweep_threads_total'
    )
  } finally {
    db.close()
  }
})

it('rejects databases older than the retained migration history', () => {
  const db = new Database(':memory:')
  try {
    expect(() => migrateSchema(db, MINIMUM_MIGRATABLE_SCHEMA_VERSION - 1)).toThrow(
      `can migrate v${MINIMUM_MIGRATABLE_SCHEMA_VERSION} through v${CURRENT_SCHEMA_VERSION}`
    )
  } finally {
    db.close()
  }
})

it('upgrades v29 outbox rows without changing their contents or owning account', () => {
  const db = new Database(':memory:')
  const fresh = openDatabase(':memory:')
  try {
    db.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, account_id TEXT, body_text TEXT, state TEXT);
      INSERT INTO outbox VALUES ('saved', 'me@example.com', 'Keep this draft', 'drafted');
      PRAGMA user_version = 29;`)
    migrateSchema(db, 29)
    expect(db.prepare('SELECT * FROM outbox').get()).toEqual({
      id: 'saved',
      account_id: 'me@example.com',
      body_text: 'Keep this draft',
      state: 'drafted',
      sender_email: null
    })
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      (fresh.pragma('table_info(outbox)') as { name: string }[]).some(
        (column) => column.name === 'sender_email'
      )
    ).toBe(true)
  } finally {
    db.close()
    fresh.close()
  }
})
