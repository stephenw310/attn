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
  ConversationMailbox,
  ConversationMsg,
  MailLabel,
  MessageAttachment,
  MessageBodyState,
  MessageMailbox,
  MessageRecipients,
  SnoozedThreadRow,
  ThreadRow
} from '../../shared/mail'
import { messageLabelsMatchMailbox } from '../../shared/mail'
import { needsBodyHydration } from '../sync/bodyHydration'
import type { Db } from './index'

interface StoredAttachment extends MessageAttachment {
  inlineData?: string
}

interface StoredOutboxAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  contentId?: string
  inline?: boolean
}

/** Measured-safe bound; the renderer windows lists above 500 rows. */
export const THREAD_LIST_LIMIT = 10_000

function labelIds(value: string): string[] {
  return value ? value.split('\u001f') : []
}

function allMailMembershipSql(): string {
  const threadLabel = (label: string): string => `
    EXISTS (SELECT 1 FROM thread_labels tl
            WHERE tl.account_id = t.account_id AND tl.thread_id = t.id
              AND tl.label_id = '${label}')`
  const storedLabel = (label: string): string => `
    EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = '${label}')`

  const junkThreadLabels = ['SPAM', 'TRASH'].map((label) => threadLabel(label)).join(' OR ')
  const hiddenStoredLabels = ['SPAM', 'TRASH', 'DRAFT', 'CHAT']
    .map((label) => storedLabel(label))
    .join(' OR ')
  const hiddenFallbackLabels = ['SPAM', 'TRASH', 'DRAFT', 'CHAT']
    .map((label) => threadLabel(label))
    .join(' OR ')
  return `(NOT (${junkThreadLabels}) AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id AND m.thread_id = t.id
    )) OR EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id AND m.thread_id = t.id
        AND ((m.labels_json IS NOT NULL AND NOT (${hiddenStoredLabels}))
             OR (m.labels_json IS NULL AND NOT (${hiddenFallbackLabels})))
    )`
}

/** One membership rule for the future All Mail, Spam, and Trash list surfaces. */
export function listMailboxThreadIds(
  db: Db,
  accountId: string,
  mailbox: MessageMailbox,
  limit = THREAD_LIST_LIMIT
): string[] {
  if (mailbox === 'spam' || mailbox === 'trash') {
    return (
      db
        .prepare(
          `SELECT t.id
           FROM thread_labels mailbox
           JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
           WHERE mailbox.account_id = ? AND mailbox.label_id = ?
           ORDER BY t.last_msg_at DESC, t.id
           LIMIT ?`
        )
        .all(accountId, mailbox.toUpperCase(), limit) as { id: string }[]
    ).map((row) => row.id)
  }
  return (
    db
      .prepare(
        `SELECT t.id FROM threads t
         WHERE t.account_id = ? AND ${allMailMembershipSql()}
         ORDER BY t.last_msg_at DESC, t.id
         LIMIT ?`
      )
      .all(accountId, limit) as { id: string }[]
  ).map((row) => row.id)
}

export function listInboxThreads(db: Db, accountId: string, limit = THREAD_LIST_LIMIT): ThreadRow[] {
  const rows = db
    .prepare(
      `WITH visible AS (
         SELECT t.account_id, t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
                t.is_unread, t.is_starred, t.has_attachment,
              EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'snooze' AND r.state = 'returned') AS returned,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft
         FROM threads t
         JOIN thread_labels inbox
           ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
         WHERE t.account_id = ? AND t.is_inbox_visible = 1
         ORDER BY t.last_msg_at DESC
         LIMIT ?
       )
       SELECT v.*,
              COALESCE((SELECT GROUP_CONCAT(tl.label_id, char(31))
                        FROM thread_labels tl
                        WHERE tl.account_id = v.account_id AND tl.thread_id = v.id), '') AS label_ids
       FROM visible v
       ORDER BY v.last_msg_at DESC`
    )
    .all(accountId, limit) as {
    account_id: string
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
    label_ids: string
  }[]

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
    labelIds: labelIds(r.label_ids)
  }))
}

export function listSnoozedThreads(db: Db, accountId: string, limit = THREAD_LIST_LIMIT): SnoozedThreadRow[] {
  const rows = db
    .prepare(
      `WITH visible AS (
         SELECT t.account_id, t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
                t.is_unread, t.is_starred, t.has_attachment, r.due_at,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft
         FROM reminders r
         JOIN threads t ON t.account_id = r.account_id AND t.id = r.thread_id
         WHERE r.account_id = ? AND r.kind = 'snooze' AND r.state = 'pending'
         ORDER BY r.due_at ASC
         LIMIT ?
       )
       SELECT v.*,
              COALESCE((SELECT GROUP_CONCAT(tl.label_id, char(31))
                        FROM thread_labels tl
                        WHERE tl.account_id = v.account_id AND tl.thread_id = v.id), '') AS label_ids
       FROM visible v
       ORDER BY v.due_at ASC`
    )
    .all(accountId, limit) as {
    account_id: string
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
    label_ids: string
  }[]

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
    labelIds: labelIds(r.label_ids),
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
  missingBodyState: Exclude<MessageBodyState, 'complete'>,
  mailbox: ConversationMailbox = 'normal'
): Conversation | null {
  const thread = db
    .prepare('SELECT subject FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, threadId) as { subject: string | null } | undefined
  if (!thread) return null

  const fallbackLabels = new Set(
    (
      db
        .prepare('SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ?')
        .all(accountId, threadId) as { label_id: string }[]
    ).map((row) => row.label_id)
  )
  const rows = db
    .prepare(
      `SELECT id, from_name, from_email, internal_date, body_text, body_html, recipients_json,
              attachments_json, labels_json, snippet, rfc_message_id, references_json
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
    labels_json: string | null
    snippet: string | null
    rfc_message_id: string | null
    references_json: string | null
  }[]

  const messages: ConversationMsg[] = rows
    .filter((row) => messageVisibleInMailbox(row.labels_json, fallbackLabels, mailbox))
    .map((r) => ({
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

interface OutboxConversationRow {
  id: string
  state: 'queued' | 'sending' | 'sent'
  to_json: string
  cc_json: string
  bcc_json: string
  body_html: string
  body_text: string
  attachments_json: string
  quote_html: string
  quote_text: string
  references_json: string
  rfc_message_id: string
  gmail_message_id: string | null
  updated_at: number
}

function combinedBody(primary: string, quote: string, separator: string): string {
  if (!quote) return primary
  if (!primary) return quote
  return `${primary}${separator}${quote}`
}

const LEGACY_SENT_MATCH_WINDOW_MS = 2 * 60 * 1_000

function canonicalSentBody(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Renderer-facing conversation projection. Reply and forward rows enter the
 * local conversation as soon as they are queued, then disappear automatically
 * when undo returns them to composing. A confirmed Gmail message replaces the
 * projection by its durable Message-ID (or mirrored Gmail message id).
 */
export function getConversationForDisplay(
  db: Db,
  accountId: string,
  threadId: string,
  missingBodyState: Exclude<MessageBodyState, 'complete'>,
  mailbox: ConversationMailbox = 'normal'
): Conversation | null {
  const conversation = getConversation(db, accountId, threadId, missingBodyState, mailbox)
  if (!conversation) return null
  if (mailbox === 'spam' || mailbox === 'trash') return conversation

  const account = db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as
    | { email: string }
    | undefined
  const confirmedMessageIds = new Set(conversation.messages.map((message) => message.id))
  const confirmedByRfcId = new Map(
    conversation.messages.flatMap((message) =>
      message.rfcMessageId ? [[message.rfcMessageId, message.id] as const] : []
    )
  )
  const rows = db
    .prepare(
      `SELECT id, state, to_json, cc_json, bcc_json, body_html, body_text, attachments_json,
              quote_html, quote_text, references_json, rfc_message_id, gmail_message_id, updated_at
       FROM outbox
       WHERE account_id = ? AND thread_id = ?
         AND kind IN ('reply', 'replyAll', 'forward')
         AND state IN ('queued', 'sending', 'sent')
       ORDER BY updated_at, id`
    )
    .all(accountId, threadId) as OutboxConversationRow[]

  const claimedConfirmedIds = new Set<string>()
  const pending = rows.flatMap((row): ConversationMsg[] => {
    const confirmedId =
      confirmedByRfcId.get(row.rfc_message_id) ??
      (row.gmail_message_id !== null && confirmedMessageIds.has(row.gmail_message_id)
        ? row.gmail_message_id
        : null)
    if (confirmedId) {
      claimedConfirmedIds.add(confirmedId)
      return []
    }
    const bodyText = combinedBody(row.body_text, row.quote_text, '\n\n')
    // Older Attn builds did not retain the definitive Gmail message id returned
    // by drafts.send: the field can be empty or still contain the obsolete draft
    // message id. Gmail may also rewrite our RFC Message-ID. Match those sent
    // projections once by author, body, and the narrow send-time window so
    // existing conversations heal without hiding queued mail.
    if (row.state === 'sent' && account) {
      const canonicalBody = canonicalSentBody(bodyText)
      const legacyMatch = conversation.messages
        .filter(
          (message) =>
            canonicalBody.length > 0 &&
            !claimedConfirmedIds.has(message.id) &&
            message.fromEmail.trim().toLowerCase() === account.email.trim().toLowerCase() &&
            Math.abs(message.at - row.updated_at) <= LEGACY_SENT_MATCH_WINDOW_MS &&
            canonicalSentBody(message.bodyText) === canonicalBody
        )
        .sort((left, right) => Math.abs(left.at - row.updated_at) - Math.abs(right.at - row.updated_at))[0]
      if (legacyMatch) {
        claimedConfirmedIds.add(legacyMatch.id)
        return []
      }
    }
    const storedAttachments = parseJson<StoredOutboxAttachment[]>(row.attachments_json, [])
    const hasInlineAttachment = storedAttachments.some((attachment) => attachment.inline)
    const bodyHtml = hasInlineAttachment ? '' : combinedBody(row.body_html, row.quote_html, '\n')
    return [
      {
        id: `outbox:${row.id}`,
        pending: true,
        rfcMessageId: row.rfc_message_id,
        references: parseJson(row.references_json, []),
        fromName: 'Me',
        fromEmail: account?.email ?? accountId,
        at: row.updated_at,
        recipients: {
          to: parseJson(row.to_json, []),
          cc: parseJson(row.cc_json, []),
          bcc: parseJson(row.bcc_json, []),
          replyTo: []
        },
        attachments: storedAttachments.map((attachment) => ({
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          ...(attachment.inline ? { inline: true } : {})
        })),
        bodyText,
        // Inline CID bytes still belong to the draft spool. Use the complete
        // plain-text alternative until Gmail returns a real message id rather
        // than rendering broken image placeholders during the undo window.
        bodyHtml: bodyHtml || null,
        bodyState: 'complete'
      }
    ]
  })

  return pending.length > 0
    ? { ...conversation, messages: [...conversation.messages, ...pending] }
    : conversation
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

function messageVisibleInMailbox(
  labelsJson: string | null,
  fallbackLabels: ReadonlySet<string>,
  mailbox: ConversationMailbox
): boolean {
  if (labelsJson === null) {
    // A thread-level union cannot identify which legacy row carries junk. Keep
    // pre-S2 normal-reader behavior and show the whole thread in a matching
    // junk mailbox until an authoritative refetch fills labels_json.
    if (mailbox === 'normal' || mailbox === 'all-mail') return true
    return fallbackLabels.has(mailbox.toUpperCase())
  }
  return messageLabelsMatchMailbox(new Set(parseJson(labelsJson, [] as string[])), mailbox)
}

function parseJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T)
}
