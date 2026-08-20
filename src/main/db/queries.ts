// Read queries for the renderer. Plain Node module (no Electron imports).

import { isValidEmail } from '../../shared/address'
import {
  CONTACT_CANDIDATE_LIMIT,
  CONTACT_SEARCH_LIMIT,
  type ContactSearchResult,
  type ContactStats,
  displayName,
  foldForSearch,
  rankContacts
} from '../../shared/contacts'
import type {
  Conversation,
  ConversationMsg,
  MailLabel,
  MessageAttachment,
  MessageBodyState,
  MessageRecipients,
  SnoozedThreadRow,
  ThreadRow
} from '../../shared/mail'
import { needsBodyHydration } from '../sync/bodyHydration'
import type { Db } from './index'

interface StoredAttachment extends MessageAttachment {
  inlineData?: string
}

/** Measured-safe bound; the renderer windows lists above 500 rows. */
export const THREAD_LIST_LIMIT = 10_000

function labelIdsForThreads(db: Db, accountId: string, threadIds: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (threadIds.length === 0) return result
  const placeholders = threadIds.map(() => '?').join(', ')
  const memberships = db
    .prepare(
      `SELECT thread_id, label_id FROM thread_labels
       WHERE account_id = ? AND thread_id IN (${placeholders})`
    )
    .all(accountId, ...threadIds) as { thread_id: string; label_id: string }[]
  for (const membership of memberships) {
    const ids = result.get(membership.thread_id) ?? []
    ids.push(membership.label_id)
    result.set(membership.thread_id, ids)
  }
  return result
}

export function listInboxThreads(db: Db, accountId: string, limit = THREAD_LIST_LIMIT): ThreadRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
              t.is_unread, t.is_starred, t.has_attachment,
              EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'snooze' AND r.state = 'returned') AS returned,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft
       FROM threads t
       WHERE t.account_id = ?
         AND t.is_inbox_visible = 1
         AND EXISTS (SELECT 1 FROM thread_labels tl
                     WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX')
       ORDER BY t.last_msg_at DESC
       LIMIT ?`
    )
    .all(accountId, limit) as {
    id: string
    from_display: string | null
    subject: string | null
    snippet: string | null
    last_msg_at: number | null
    is_unread: number
    is_starred: number
    has_attachment: number
    returned: number
    has_draft: number
  }[]

  const labelIds = labelIdsForThreads(
    db,
    accountId,
    rows.map((row) => row.id)
  )
  return rows.map((r) => ({
    id: r.id,
    fromDisplay: r.from_display ?? '',
    subject: r.subject ?? '(no subject)',
    snippet: r.snippet ?? '',
    lastMsgAt: r.last_msg_at ?? 0,
    unread: r.is_unread === 1,
    starred: r.is_starred === 1,
    hasAttachment: r.has_attachment === 1,
    returned: r.returned === 1,
    hasDraft: r.has_draft === 1,
    labelIds: labelIds.get(r.id) ?? []
  }))
}

export function listSnoozedThreads(db: Db, accountId: string, limit = THREAD_LIST_LIMIT): SnoozedThreadRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
              t.is_unread, t.is_starred, t.has_attachment, r.due_at,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft
       FROM reminders r
       JOIN threads t ON t.account_id = r.account_id AND t.id = r.thread_id
       WHERE r.account_id = ? AND r.kind = 'snooze' AND r.state = 'pending'
       ORDER BY r.due_at ASC
       LIMIT ?`
    )
    .all(accountId, limit) as {
    id: string
    from_display: string | null
    subject: string | null
    snippet: string | null
    last_msg_at: number | null
    is_unread: number
    is_starred: number
    has_attachment: number
    due_at: number
    has_draft: number
  }[]

  const labelIds = labelIdsForThreads(
    db,
    accountId,
    rows.map((row) => row.id)
  )
  return rows.map((r) => ({
    id: r.id,
    fromDisplay: r.from_display ?? '',
    subject: r.subject ?? '(no subject)',
    snippet: r.snippet ?? '',
    lastMsgAt: r.last_msg_at ?? 0,
    unread: r.is_unread === 1,
    starred: r.is_starred === 1,
    hasAttachment: r.has_attachment === 1,
    returned: false,
    hasDraft: r.has_draft === 1,
    labelIds: labelIds.get(r.id) ?? [],
    dueAt: r.due_at
  }))
}

export function listUserLabels(db: Db, accountId: string): MailLabel[] {
  return db
    .prepare(
      `SELECT id, name, type FROM labels
       WHERE account_id = ? AND lower(type) = 'user'
       ORDER BY name COLLATE NOCASE, id`
    )
    .all(accountId) as MailLabel[]
}

export function countInboxUnread(db: Db, accountId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM threads t
       WHERE t.account_id = ?
         AND t.is_inbox_visible = 1
         AND t.is_unread = 1
         AND EXISTS (SELECT 1 FROM thread_labels tl
                     WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX')`
    )
    .get(accountId) as { count: number }

  return row.count
}

export function getConversation(
  db: Db,
  accountId: string,
  threadId: string,
  missingBodyState: Exclude<MessageBodyState, 'complete'>
): Conversation | null {
  const thread = db
    .prepare('SELECT subject FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, threadId) as { subject: string | null } | undefined
  if (!thread) return null

  const rows = db
    .prepare(
      `SELECT id, from_name, from_email, internal_date, body_text, body_html, recipients_json,
              attachments_json, snippet, rfc_message_id, references_json
       FROM messages WHERE account_id = ? AND thread_id = ?
       ORDER BY internal_date ASC`
    )
    .all(accountId, threadId) as {
    id: string
    from_name: string | null
    from_email: string | null
    internal_date: number | null
    body_text: string | null
    body_html: string | null
    recipients_json: string | null
    attachments_json: string | null
    snippet: string | null
    rfc_message_id: string | null
    references_json: string | null
  }[]

  const messages: ConversationMsg[] = rows.map((r) => ({
    id: r.id,
    rfcMessageId: r.rfc_message_id,
    references: parseJson(r.references_json, []),
    fromName: r.from_name ?? '',
    fromEmail: r.from_email ?? '',
    at: r.internal_date ?? 0,
    recipients: parseJson(r.recipients_json, EMPTY_RECIPIENTS),
    attachments: parseJson<StoredAttachment[]>(r.attachments_json, []).map(
      ({ inlineData: _inlineData, ...attachment }) => attachment
    ),
    bodyText: r.body_text || r.snippet || '',
    bodyHtml: r.body_html,
    bodyState: needsBodyHydration({ bodyText: r.body_text, bodyHtml: r.body_html })
      ? missingBodyState
      : 'complete'
  }))

  return { threadId, subject: thread.subject ?? '(no subject)', messages }
}

interface ContactRow {
  email: string
  name: string | null
  sent_to_count: number
  received_count: number
  last_interacted_at: number
  name_prefix: number
}

const CONTACT_COLUMNS = 'email, name, sent_to_count, received_count, last_interacted_at'
const VALID_CONTACT_EMAIL_SQL = `
  email = trim(email)
  AND instr(email, ' ') = 0
  AND instr(email, char(9)) = 0
  AND instr(email, char(10)) = 0
  AND instr(email, char(11)) = 0
  AND instr(email, char(12)) = 0
  AND instr(email, char(13)) = 0
  AND instr(email, '<') = 0
  AND instr(email, '>') = 0
  AND instr(email, '@') > 1
  AND instr(substr(email, instr(email, '@') + 1), '@') = 0
  AND instr(substr(email, instr(email, '@') + 1), '.') > 1
  AND substr(email, -1) <> '.'`

/**
 * Half-open upper bound for a prefix range scan: the needle with its final code
 * point incremented. Range bounds rather than LIKE 'x%' so the comparison is
 * unambiguously index-driven — the columns are pre-folded, so a binary range is
 * exactly the right match semantics.
 */
function prefixUpperBound(prefix: string): string {
  const points = [...prefix]
  const last = points.pop()
  if (last === undefined) return ''
  return points.join('') + String.fromCodePoint((last.codePointAt(0) ?? 0) + 1)
}

/**
 * Local autocomplete over the materialized contact projection. SQL owns matching
 * and rankContacts owns ordering — one implementation each, so tuning the formula
 * in shared/contacts.ts actually changes what the user sees.
 *
 * Prefix matches outrank every infix match, so they are fetched in full and are
 * never subject to a candidate cap: capping them would let 200 newer or heavier
 * infix matches bury the exact address the user is typing. The prefix scan is a
 * bounded index range, so fetching all of them is cheap. The infix scan is the
 * expensive one — a broad needle matches nearly every address — so it runs only
 * when prefix matches cannot already fill the result, and is capped there. A
 * dropped infix candidate can only reorder the low-confidence tail; a dropped
 * prefix candidate loses the thing the user meant.
 *
 * Addresses and names are stored pre-folded, so matching needs no per-row lower()
 * and non-ASCII names fold correctly — SQLite's lower() would leave "Ürsula"
 * unmatched by "ürsula".
 */
export function searchContacts(
  db: Db,
  accountId: string,
  query: string,
  now = Date.now()
): ContactSearchResult[] {
  const needle = foldForSearch(query)
  // account_id doubles as the email in v1, but read the account row so a future
  // opaque account id (SPEC D4) cannot start suggesting the signed-in address.
  const account = db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as
    | { email: string }
    | undefined
  const selfEmail = account?.email ?? accountId

  const rows = (needle ? contactPrefixMatches(db, accountId, needle) : []).filter((row) =>
    isValidEmail(row.email)
  )
  const ranked = rankContacts(toStats(rows), query, selfEmail, now)
  const candidates =
    ranked.length >= CONTACT_SEARCH_LIMIT
      ? rows
      : mergeContacts(
          rows,
          contactInfixMatches(db, accountId, needle).filter((row) => isValidEmail(row.email))
        )

  const names = new Map(candidates.map((row) => [row.email, row.name]))
  return rankContacts(toStats(candidates), query, selfEmail, now).map((contact) => ({
    name: displayName(names.get(contact.email), contact.email),
    email: contact.email,
    score: contact.score
  }))
}

function toStats(rows: readonly ContactRow[]): ContactStats[] {
  return rows.map((row) => ({
    email: row.email,
    sentToCount: row.sent_to_count,
    receivedCount: row.received_count,
    lastInteractedAt: row.last_interacted_at,
    nameMatchesPrefix: row.name_prefix === 1
  }))
}

function mergeContacts(primary: readonly ContactRow[], extra: readonly ContactRow[]): ContactRow[] {
  const seen = new Set(primary.map((row) => row.email))
  return [...primary, ...extra.filter((row) => !seen.has(row.email))]
}

/** Every address or name starting with the needle — uncapped, index-ranged. */
function contactPrefixMatches(db: Db, accountId: string, needle: string): ContactRow[] {
  return db
    .prepare(
      `SELECT ${CONTACT_COLUMNS},
              CASE WHEN name_folded >= @lo AND name_folded < @hi THEN 1 ELSE 0 END AS name_prefix
       FROM contacts
       WHERE account_id = @account_id
         AND ${VALID_CONTACT_EMAIL_SQL}
         AND ((email >= @lo AND email < @hi) OR (name_folded >= @lo AND name_folded < @hi))`
    )
    .all({ account_id: accountId, lo: needle, hi: prefixUpperBound(needle) }) as ContactRow[]
}

/**
 * Capped infix fill, run only when prefix matches cannot fill the result. One scan
 * ordered by recency rather than a union of recency and weight: prefix matches are
 * now exhaustive, so this cap can only reorder the low-confidence tail beneath
 * them, and the second ordering cost a whole extra table scan to defend it.
 */
function contactInfixMatches(db: Db, accountId: string, needle: string): ContactRow[] {
  const escaped = needle.replace(/[\\%_]/g, '\\$&')
  return db
    .prepare(
      `SELECT ${CONTACT_COLUMNS},
              CASE WHEN COALESCE(name_folded, '') LIKE @prefix ESCAPE '\\'
                   THEN 1 ELSE 0 END AS name_prefix
       FROM contacts
       WHERE account_id = @account_id
         AND ${VALID_CONTACT_EMAIL_SQL}
         AND (email LIKE @infix ESCAPE '\\'
              OR COALESCE(name_folded, '') LIKE @infix ESCAPE '\\')
       ORDER BY last_interacted_at DESC
       LIMIT @candidates`
    )
    .all({
      account_id: accountId,
      prefix: `${escaped}%`,
      infix: `%${escaped}%`,
      candidates: CONTACT_CANDIDATE_LIMIT
    }) as ContactRow[]
}

export function getInlineAttachmentData(
  db: Db,
  accountId: string,
  messageId: string,
  attachmentId: string
): string | null {
  const row = db
    .prepare('SELECT attachments_json FROM messages WHERE account_id = ? AND id = ?')
    .get(accountId, messageId) as { attachments_json: string | null } | undefined
  const attachment = parseJson<StoredAttachment[]>(row?.attachments_json ?? null, []).find(
    (candidate) => candidate.attachmentId === attachmentId
  )
  return typeof attachment?.inlineData === 'string' ? attachment.inlineData : null
}

const EMPTY_RECIPIENTS: MessageRecipients = { to: [], cc: [], bcc: [], replyTo: [] }

function parseJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T)
}
