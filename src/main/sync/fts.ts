// Full-text index maintenance (F10). The index is derived state over stored
// rows: every writer reconciles it inside the same transaction as the row
// change, so a search can never return mail the store no longer holds.
//
// Table-shape decision (T23): a mapping table owns the FTS rowid instead of an
// external-content table over `messages`. External content requires FTS5 to
// read back exactly the indexed text from the content table at query time, and
// none of the indexed strings exist as stored columns — the subject lives on
// `threads`, recipients and filenames are JSON, and HTML-only bodies are
// indexed stripped. The duplicated text is the accepted cost, measured by the
// perf suite. Deletes are rowid deletes through `message_fts_map`.

import type { SearchCoverage } from '../../shared/searchQuery'
import type { Db } from '../db'
import { textFromRaw } from '../gmail/parse'

interface StoredMessageRow {
  id: string
  thread_id: string
  internal_date: number | null
  subject: string | null
  from_name: string | null
  from_email: string | null
  body_text: string | null
  body_html: string | null
  recipients_json: string | null
  attachments_json: string | null
}

interface FtsColumns {
  subject: string
  sender: string
  recipients: string
  body: string
  filenames: string
}

interface StoredFtsRow extends FtsColumns {
  account_id: string
}

export interface FtsWriteCounts {
  inserted: number
  updated: number
  removed: number
  unchanged: number
}

const STORED_ROW_COLUMNS = `
  m.id, m.thread_id, m.internal_date, t.subject, m.from_name, m.from_email, m.body_text, m.body_html,
  m.recipients_json, m.attachments_json`

function parseJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Derive the indexed body from stored columns; markup never reaches the tokenizer. */
function bodyColumnFor(bodyText: string | null, bodyHtml: string | null): string {
  if (bodyText?.trim()) return bodyText
  if (bodyHtml) return textFromRaw('text/html', bodyHtml)
  return ''
}

function recipientsColumnFor(recipientsJson: string | null): string {
  const parsed = parseJson(recipientsJson)
  if (!parsed || typeof parsed !== 'object') return ''
  const parts: string[] = []
  for (const role of ['to', 'cc', 'bcc', 'replyTo'] as const) {
    const list = (parsed as Record<string, unknown>)[role]
    if (!Array.isArray(list)) continue
    for (const address of list) {
      if (!address || typeof address !== 'object') continue
      const { name, email } = address as { name?: unknown; email?: unknown }
      if (typeof name === 'string' && name.trim()) parts.push(name.trim())
      if (typeof email === 'string' && email.trim()) parts.push(email.trim())
    }
  }
  return parts.join(' ')
}

function filenamesColumnFor(attachmentsJson: string | null): string {
  const parsed = parseJson(attachmentsJson)
  if (!Array.isArray(parsed)) return ''
  const names: string[] = []
  for (const attachment of parsed) {
    if (!attachment || typeof attachment !== 'object') continue
    const { filename, inline } = attachment as { filename?: unknown; inline?: unknown }
    // Inline CID resources carry generated names; only user-visible attachments
    // should answer a filename search.
    if (inline === true || typeof filename !== 'string' || !filename.trim()) continue
    names.push(filename.trim())
  }
  return names.join(' ')
}

function ftsColumnsFor(row: StoredMessageRow): FtsColumns {
  return {
    subject: row.subject ?? '',
    sender: [row.from_name, row.from_email].filter(Boolean).join(' '),
    recipients: recipientsColumnFor(row.recipients_json),
    body: bodyColumnFor(row.body_text, row.body_html),
    filenames: filenamesColumnFor(row.attachments_json)
  }
}

function sameColumns(left: FtsColumns, right: FtsColumns): boolean {
  return (
    left.subject === right.subject &&
    left.sender === right.sender &&
    left.recipients === right.recipients &&
    left.body === right.body &&
    left.filenames === right.filenames
  )
}

/**
 * Upsert index rows for stored messages. Rewrites of unchanged text are
 * skipped: label-only re-persists are the hot path, and an FTS update is a
 * full delete-and-reinsert of the message's tokens.
 */
function upsertStoredRows(db: Db, accountId: string, rows: StoredMessageRow[]): FtsWriteCounts {
  const counts: FtsWriteCounts = { inserted: 0, updated: 0, removed: 0, unchanged: 0 }
  if (rows.length === 0) return counts
  const selectMapped = db.prepare(
    `SELECT fts_rowid, thread_id, internal_date FROM message_fts_map
     WHERE account_id = ? AND message_id = ?`
  )
  const selectIndexed = db.prepare(
    'SELECT account_id, subject, sender, recipients, body, filenames FROM message_fts WHERE rowid = ?'
  )
  const updateIndexed = db.prepare(
    `UPDATE message_fts
     SET account_id = ?, subject = ?, sender = ?, recipients = ?, body = ?, filenames = ?
     WHERE rowid = ?`
  )
  const insertIndexed = db.prepare(
    `INSERT INTO message_fts (account_id, subject, sender, recipients, body, filenames)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const restoreIndexed = db.prepare(
    `INSERT INTO message_fts (rowid, account_id, subject, sender, recipients, body, filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insertMapping = db.prepare(
    `INSERT INTO message_fts_map (account_id, message_id, thread_id, fts_rowid, internal_date)
     VALUES (?, ?, ?, ?, ?)`
  )
  // The date rides along on every write, so a bounded search can order by it
  // without joining the messages it is trying to avoid reading.
  const moveMapping = db.prepare(
    `UPDATE message_fts_map SET thread_id = ?, internal_date = ?
     WHERE account_id = ? AND message_id = ?`
  )

  for (const row of rows) {
    const next = ftsColumnsFor(row)
    const mapped = selectMapped.get(accountId, row.id) as
      | { fts_rowid: number; thread_id: string; internal_date: number | null }
      | undefined
    if (!mapped) {
      const inserted = insertIndexed.run(
        accountId,
        next.subject,
        next.sender,
        next.recipients,
        next.body,
        next.filenames
      )
      insertMapping.run(accountId, row.id, row.thread_id, inserted.lastInsertRowid, row.internal_date)
      counts.inserted++
      continue
    }
    if (mapped.thread_id !== row.thread_id || mapped.internal_date !== row.internal_date) {
      moveMapping.run(row.thread_id, row.internal_date, accountId, row.id)
    }
    const current = selectIndexed.get(mapped.fts_rowid) as StoredFtsRow | undefined
    if (!current) {
      restoreIndexed.run(
        mapped.fts_rowid,
        accountId,
        next.subject,
        next.sender,
        next.recipients,
        next.body,
        next.filenames
      )
      counts.updated++
      continue
    }
    if (current.account_id === accountId && sameColumns(current, next)) {
      counts.unchanged++
      continue
    }
    updateIndexed.run(
      accountId,
      next.subject,
      next.sender,
      next.recipients,
      next.body,
      next.filenames,
      mapped.fts_rowid
    )
    counts.updated++
  }
  return counts
}

function deleteMappedRows(db: Db, rows: { fts_rowid: number }[]): void {
  const deleteIndexed = db.prepare('DELETE FROM message_fts WHERE rowid = ?')
  const deleteMapping = db.prepare('DELETE FROM message_fts_map WHERE fts_rowid = ?')
  for (const row of rows) {
    deleteIndexed.run(row.fts_rowid)
    deleteMapping.run(row.fts_rowid)
  }
}

/**
 * Reconcile one thread's index rows with its stored messages: upsert every
 * stored message and drop index rows for messages the snapshot removed. Runs
 * inside the caller's transaction, after the thread row is current.
 */
export function indexThreadMessages(db: Db, accountId: string, threadId: string): FtsWriteCounts {
  const rows = db
    .prepare(
      `SELECT ${STORED_ROW_COLUMNS}
       FROM messages m
       LEFT JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
       WHERE m.account_id = ? AND m.thread_id = ?`
    )
    .all(accountId, threadId) as StoredMessageRow[]
  const counts = upsertStoredRows(db, accountId, rows)

  const storedIds = new Set(rows.map((row) => row.id))
  const stale = (
    db
      .prepare('SELECT message_id, fts_rowid FROM message_fts_map WHERE account_id = ? AND thread_id = ?')
      .all(accountId, threadId) as { message_id: string; fts_rowid: number }[]
  ).filter((row) => !storedIds.has(row.message_id))
  deleteMappedRows(db, stale)
  counts.removed += stale.length
  return counts
}

/** Upsert index rows for specific stored messages (the backfill's batch shape). */
export function indexStoredMessages(db: Db, accountId: string, messageIds: string[]): FtsWriteCounts {
  if (messageIds.length === 0) return { inserted: 0, updated: 0, removed: 0, unchanged: 0 }
  const placeholders = messageIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ${STORED_ROW_COLUMNS}
       FROM messages m
       LEFT JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
       WHERE m.account_id = ? AND m.id IN (${placeholders})`
    )
    .all(accountId, ...messageIds) as StoredMessageRow[]
  return upsertStoredRows(db, accountId, rows)
}

/** Remove every index row of a deleted thread. Runs inside the caller's transaction. */
export function removeThreadFromIndex(db: Db, accountId: string, threadId: string): void {
  const rows = db
    .prepare('SELECT fts_rowid FROM message_fts_map WHERE account_id = ? AND thread_id = ?')
    .all(accountId, threadId) as { fts_rowid: number }[]
  deleteMappedRows(db, rows)
}

/** Remove all mapped and orphaned index rows for an account inside the caller's transaction. */
export function removeAccountFromIndex(db: Db, accountId: string): void {
  const mapped = db.prepare('SELECT fts_rowid FROM message_fts_map WHERE account_id = ?').all(accountId) as {
    fts_rowid: number
  }[]
  deleteMappedRows(db, mapped)
  db.prepare('DELETE FROM message_fts WHERE account_id = ?').run(accountId)
}

/** Re-derive the body column after a stored body changed (hydration fills). */
export function refreshMessageBodyFromStore(db: Db, accountId: string, messageId: string): void {
  const mapped = db
    .prepare('SELECT fts_rowid FROM message_fts_map WHERE account_id = ? AND message_id = ?')
    .get(accountId, messageId) as { fts_rowid: number } | undefined
  if (!mapped) return
  const stored = db
    .prepare('SELECT body_text, body_html FROM messages WHERE account_id = ? AND id = ?')
    .get(accountId, messageId) as { body_text: string | null; body_html: string | null } | undefined
  if (!stored) return
  const body = bodyColumnFor(stored.body_text, stored.body_html)
  const current = db
    .prepare('SELECT account_id, body FROM message_fts WHERE rowid = ?')
    .get(mapped.fts_rowid) as { account_id: string; body: string } | undefined
  if (!current || current.account_id !== accountId) {
    indexStoredMessages(db, accountId, [messageId])
    return
  }
  if (current.body === body) return
  db.prepare('UPDATE message_fts SET body = ? WHERE rowid = ?').run(body, mapped.fts_rowid)
}

export interface SearchIndexHit {
  threadId: string
  score: number
}

/**
 * Rank threads by their best-matching message. `match` is raw FTS5 MATCH
 * syntax; translating user queries into it is the search UI's job (T24).
 */
export function searchMessageIndex(
  db: Db,
  accountId: string,
  match: string,
  limit: number
): SearchIndexHit[] {
  // The bm25() function itself cannot sit inside an aggregate; the `rank`
  // auxiliary column carries the same score and can.
  return db
    .prepare(
      `SELECT map.thread_id AS threadId, MIN(message_fts.rank) AS score
       FROM message_fts
       JOIN message_fts_map map ON map.fts_rowid = message_fts.rowid
       WHERE message_fts MATCH ? AND map.account_id = ? AND message_fts.account_id = ?
       GROUP BY map.thread_id
       ORDER BY score
       LIMIT ?`
    )
    .all(match, accountId, accountId, limit) as SearchIndexHit[]
}

/** The store-side coverage state the search UI's disclosure line renders (T24). */
export function searchCoverage(db: Db, accountId: string): SearchCoverage {
  const cursors = db
    .prepare(
      `SELECT backfill_cursor, sweep_cursor, attachment_cursor, fts_cursor
       FROM sync_state WHERE account_id = ?`
    )
    .get(accountId) as
    | {
        backfill_cursor: string | null
        sweep_cursor: string | null
        attachment_cursor: string | null
        fts_cursor: string | null
      }
    | undefined
  // Every stage after `bodies` stores headers only, so reaching one is proof the
  // store holds mail whose text is not searchable until it is opened. Reading
  // the cursor costs nothing; counting the messages cost a scan of the store.
  const eagerBodyStages = new Set([null, undefined, 'metadata', 'bodies'])
  const backfillPhase = cursors?.backfill_cursor?.split(':')[0]
  return {
    headersComplete: cursors?.sweep_cursor === 'done',
    headersCapped: cursors?.sweep_cursor?.startsWith('capped:') ?? false,
    indexComplete: cursors?.fts_cursor === 'done',
    attachmentFlagsComplete: cursors?.attachment_cursor === 'done',
    bodiesOnDemand: !eagerBodyStages.has(backfillPhase)
  }
}
