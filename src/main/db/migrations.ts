// Ordered schema migrations, applied via PRAGMA user_version.
// Never edit an entry after it has shipped — append a new one.

export const migrations: string[] = [
  // v1 — metadata-first schema for backfill + list rendering (SPEC §6).
  // Bodies and FTS5 arrive with the search milestone (M3).
  `
  CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE labels (
    account_id  TEXT NOT NULL,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE threads (
    account_id   TEXT NOT NULL,
    id           TEXT NOT NULL,
    history_id   TEXT,
    subject      TEXT,
    snippet      TEXT,
    last_msg_at  INTEGER,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX idx_threads_recent ON threads (account_id, last_msg_at DESC);

  CREATE TABLE messages (
    account_id     TEXT NOT NULL,
    id             TEXT NOT NULL,
    thread_id      TEXT NOT NULL,
    from_name      TEXT,
    from_email     TEXT,
    to_json        TEXT,
    subject        TEXT,
    snippet        TEXT,
    internal_date  INTEGER,
    is_unread      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX idx_messages_thread ON messages (account_id, thread_id, internal_date);

  CREATE TABLE thread_labels (
    account_id  TEXT NOT NULL,
    thread_id   TEXT NOT NULL,
    label_id    TEXT NOT NULL,
    PRIMARY KEY (account_id, thread_id, label_id)
  );
  CREATE INDEX idx_thread_labels_label ON thread_labels (account_id, label_id);

  CREATE TABLE sync_state (
    account_id       TEXT PRIMARY KEY,
    last_history_id  TEXT,
    backfill_cursor  TEXT,
    updated_at       INTEGER
  );
  `,

  // v2 — denormalized list-view columns + plain-text bodies for M0.
  // (Body storage moves to an FTS5-backed table at M3.)
  `
  ALTER TABLE threads ADD COLUMN from_display TEXT;
  ALTER TABLE threads ADD COLUMN is_unread INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN body_text TEXT;
  `,

  // v3 — app-global settings, starting with background launch behavior (F16).
  // Account-scoped settings will use namespaced keys when that surface lands.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
]
