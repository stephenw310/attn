// Development schema snapshot. Bump the version whenever this SQL changes.
// Runtime compatibility migrations stay out of the app; AGENTS.md documents the
// manual additive-upgrade procedure for preserving a local dogfood profile.
export const CURRENT_SCHEMA_VERSION = 12

export const CURRENT_SCHEMA = `
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
  account_id     TEXT NOT NULL,
  id             TEXT NOT NULL,
  subject        TEXT,
  snippet        TEXT,
  last_msg_at    INTEGER,
  from_display   TEXT,
  is_unread      INTEGER NOT NULL DEFAULT 0,
  is_starred     INTEGER NOT NULL DEFAULT 0,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX idx_threads_recent ON threads (account_id, last_msg_at DESC);

CREATE TABLE messages (
  account_id       TEXT NOT NULL,
  id               TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  from_name        TEXT,
  from_email       TEXT,
  snippet          TEXT,
  internal_date    INTEGER,
  body_text        TEXT,
  body_html        TEXT,
  recipients_json  TEXT,
  attachments_json TEXT,
  rfc_message_id   TEXT,
  references_json  TEXT,
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
  sweep_cursor     TEXT
);

CREATE TABLE action_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX idx_action_queue_pending ON action_queue (account_id, state, id);

CREATE TABLE settings (
  account_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);

CREATE TABLE reminders (
  account_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'snooze',
  due_at     INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (account_id, thread_id, kind)
);
CREATE INDEX idx_reminders_due ON reminders (account_id, state, due_at);

CREATE TABLE contact_messages (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL,
  name       TEXT,
  PRIMARY KEY (account_id, message_id, email, role)
);
CREATE INDEX idx_contact_messages_email
  ON contact_messages (account_id, email, message_id, role);

CREATE TABLE contacts (
  account_id          TEXT NOT NULL,
  email               TEXT NOT NULL,
  name                TEXT,
  name_folded         TEXT,
  sent_to_count       INTEGER NOT NULL DEFAULT 0,
  received_count      INTEGER NOT NULL DEFAULT 0,
  last_interacted_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, email)
);
CREATE INDEX idx_contacts_name_folded ON contacts (account_id, name_folded);

CREATE TABLE outbox (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  gmail_draft_id    TEXT,
  gmail_message_id  TEXT,
  state             TEXT NOT NULL DEFAULT 'composing',
  kind              TEXT NOT NULL DEFAULT 'new',
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  bcc_json          TEXT NOT NULL DEFAULT '[]',
  subject           TEXT NOT NULL DEFAULT '',
  body_html         TEXT NOT NULL DEFAULT '',
  body_text         TEXT NOT NULL DEFAULT '',
  attachments_json  TEXT NOT NULL DEFAULT '[]',
  thread_id         TEXT,
  source_message_id TEXT,
  in_reply_to       TEXT,
  references_json   TEXT NOT NULL DEFAULT '[]',
  quote_html        TEXT NOT NULL DEFAULT '',
  quote_text        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  local_revision    INTEGER NOT NULL DEFAULT 0,
  mirror_revision   INTEGER NOT NULL DEFAULT 0,
  remote_updated_at INTEGER,
  remote_fingerprint TEXT
);
CREATE INDEX idx_outbox_composing ON outbox (account_id, state, updated_at DESC);
CREATE INDEX idx_outbox_thread_kind ON outbox (
  account_id,
  thread_id,
  CASE WHEN kind IN ('reply', 'replyAll') THEN 'reply' ELSE kind END
) WHERE state IN ('composing', 'drafted') AND thread_id IS NOT NULL;
`
