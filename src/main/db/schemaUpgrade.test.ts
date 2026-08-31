import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from './index'

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
    const notes = readFileSync(new URL('../../../docs/M3-PLAN.md', import.meta.url), 'utf8')
    const section = notes.split('## Schema revision 21 → 22:')[1]
    const ddl = section?.match(/```sql\n([\s\S]*?)```/)?.[1]
    expect(ddl).toBeDefined()
    db.transaction(() => db.exec(ddl as string))()

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
    const notes = readFileSync(new URL('../../../docs/M4-PLAN.md', import.meta.url), 'utf8')
    const section = notes.split('## T34: snippets')[1]
    const ddl = section?.match(/```sql\n([\s\S]*?)```/)?.[1]
    expect(ddl).toBeDefined()
    // The documented block carries its own BEGIN IMMEDIATE … COMMIT.
    db.exec(ddl as string)

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
