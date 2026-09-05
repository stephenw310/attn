// Current schema snapshot for new profiles. Every change bumps this version and
// adds the matching ordered step in migrations.ts; the registry test makes a
// version-only bump fail.
export const CURRENT_SCHEMA_VERSION = 27

// The oldest profile this build can upgrade in place. Keep the complete path
// from this version to CURRENT_SCHEMA_VERSION in migrations.ts.
export const MINIMUM_MIGRATABLE_SCHEMA_VERSION = 21

// `messages.labels_json` deliberately stays nullable: NULL identifies a pre-S2
// row whose message-level labels are unknown, so readers fall back to the thread
// label union. An empty JSON array means the authoritative message has no labels.
export const CURRENT_SCHEMA = `
CREATE TABLE accounts (
  id    TEXT PRIMARY KEY,
  email TEXT NOT NULL
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
  is_inbox_visible INTEGER NOT NULL DEFAULT 1,
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
  labels_json      TEXT,
  list_id          TEXT,
  has_calendar_part INTEGER NOT NULL DEFAULT 0,
  rfc_message_id   TEXT,
  references_json  TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX idx_messages_thread ON messages (account_id, thread_id, internal_date);

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
CREATE INDEX idx_split_rules_order ON split_rules (account_id, position);

CREATE TABLE split_config (
  account_id  TEXT PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE thread_labels (
  account_id  TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  label_id    TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, label_id)
);
CREATE INDEX idx_thread_labels_label ON thread_labels (account_id, label_id);

-- Derived mailbox membership for the views whose rules are thread-level. Counting
-- and paging All Mail from the label rules costs a scan of every thread in the
-- account; from this index both are a range read. Spam and Trash stay on
-- idx_thread_labels_label: their rules are message-level, and Gmail purges both
-- at about 30 days, so neither can grow into a scan worth materializing.
-- sort_at is the view's shipped sort expression, COALESCE(threads.last_msg_at, 0).
CREATE TABLE thread_mailboxes (
  account_id TEXT NOT NULL,
  view       TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  sort_at    INTEGER NOT NULL,
  -- Keyed by thread before view: every write recomputes one thread's rows and
  -- deletes them first, and that delete has to be a key lookup. With view ahead
  -- of thread_id it was a full table scan, which made importing mail slower the
  -- more mail the store already held.
  PRIMARY KEY (account_id, thread_id, view)
);
CREATE INDEX idx_thread_mailboxes_recent
  ON thread_mailboxes (account_id, view, sort_at DESC, thread_id);

CREATE TABLE sync_state (
  account_id         TEXT PRIMARY KEY,
  last_history_id    TEXT,
  backfill_cursor    TEXT,
  sweep_cursor       TEXT,
  sweep_threads_done INTEGER NOT NULL DEFAULT 0,
  attachment_cursor  TEXT,
  split_metadata_cursor TEXT NOT NULL DEFAULT 'done',
  fts_cursor         TEXT,
  mailbox_cursor     TEXT
);

CREATE TABLE message_fts_map (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  fts_rowid  INTEGER NOT NULL,
  -- Copied from messages.internal_date so a search can take the most recent
  -- matches without joining every matching message first.
  internal_date INTEGER,
  PRIMARY KEY (account_id, message_id)
);
CREATE UNIQUE INDEX idx_message_fts_map_rowid ON message_fts_map (fts_rowid);
CREATE INDEX idx_message_fts_map_thread ON message_fts_map (account_id, thread_id);
CREATE INDEX idx_message_fts_map_recent
  ON message_fts_map (account_id, internal_date DESC, fts_rowid);

CREATE VIRTUAL TABLE message_fts USING fts5(
  account_id UNINDEXED,
  subject,
  sender,
  recipients,
  body,
  filenames,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TABLE thread_existence_state (
  account_id TEXT PRIMARY KEY,
  phase      TEXT NOT NULL,
  page_token TEXT
);

CREATE TABLE thread_existence_evidence (
  account_id       TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  was_local        INTEGER NOT NULL DEFAULT 0,
  remote_seen      INTEGER NOT NULL DEFAULT 0,
  verified_missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, thread_id)
);
CREATE INDEX idx_thread_existence_candidates ON thread_existence_evidence (
  account_id,
  was_local,
  remote_seen,
  verified_missing
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
  -- Follow-up origin (T35/F9): the sent message a reply must postdate. The
  -- Gmail id binds the reminder to its send; the RFC Message-ID breaks
  -- internal-date ties via References/In-Reply-To; internal_date is resolved
  -- from the post-send read (or the store) and a follow-up cannot fire until
  -- it is. The outbox creation time durably orders competing sends after their
  -- retained outbox rows are pruned. All four stay NULL on snooze rows.
  origin_message_id TEXT,
  origin_rfc_message_id TEXT,
  origin_internal_date INTEGER,
  origin_outbox_created_at INTEGER,
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

-- App-global reusable text blocks (F8). account_id keeps the D4 shape; v1
-- writes the app sentinel so one snippet set serves every signed-in account.
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
  default_signature_fingerprint TEXT,
  remote_fingerprint TEXT,
  rfc_message_id   TEXT,
  -- "Remind me if no reply" deadline chosen at compose (T35/F9); the reminder
  -- row is created only at the sent transition, never when queued.
  follow_up_at     INTEGER,
  send_at          INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  verify_attempts  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);
CREATE INDEX idx_outbox_composing ON outbox (account_id, state, updated_at DESC);
CREATE INDEX idx_outbox_due ON outbox (account_id, state, send_at);
CREATE INDEX idx_outbox_thread_kind ON outbox (
  account_id,
  thread_id,
  CASE WHEN kind IN ('reply', 'replyAll') THEN 'reply' ELSE kind END
) WHERE state IN ('composing', 'drafted') AND thread_id IS NOT NULL;
`
