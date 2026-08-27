import type { Draft } from '../../shared/drafts'
import type { ThreadRow } from '../../shared/mail'
import {
  type ParsedSearchQuery,
  parseSearchQuery,
  type SearchFilter,
  type SearchResponse,
  type SearchTextTerm,
  searchDateMilliseconds,
  searchMatchExpression
} from '../../shared/searchQuery'
import { listDrafts } from '../outbox/drafts'
import { searchCoverage } from '../sync/fts'
import type { Db } from './index'

export const SEARCH_RESULT_LIMIT = 100

interface SearchThreadRow {
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
}

function toThreadRow(row: SearchThreadRow): ThreadRow {
  return {
    id: row.id,
    fromDisplay: row.from_display ?? '',
    subject: row.subject ?? '(no subject)',
    snippet: row.snippet ?? '',
    lastMsgAt: row.last_msg_at ?? 0,
    unread: row.is_unread === 1,
    starred: row.is_starred === 1,
    hasAttachment: row.has_attachment === 1,
    returned: row.returned === 1,
    hasDraft: row.has_draft === 1,
    labelIds: labelIds(row.label_ids)
  }
}

function systemMailboxName(value: string): string {
  return value.toLowerCase().replaceAll(/[\s_-]/g, '')
}

function messageHasLabelExpressionSql(messageAlias: string, labelExpression: string): string {
  return `((${messageAlias}.labels_json IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(${messageAlias}.labels_json) WHERE value = ${labelExpression}
    )) OR (${messageAlias}.labels_json IS NULL AND EXISTS (
      SELECT 1 FROM thread_labels search_candidate_label
      WHERE search_candidate_label.account_id = ${messageAlias}.account_id
        AND search_candidate_label.thread_id = ${messageAlias}.thread_id
        AND search_candidate_label.label_id = ${labelExpression}
    )))`
}

function messageHasLabelSql(messageAlias: string, label: string): string {
  return messageHasLabelExpressionSql(messageAlias, `'${label}'`)
}

function normalMessageSql(messageAlias: string): string {
  return `((${messageAlias}.labels_json IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM json_each(${messageAlias}.labels_json)
      WHERE value IN ('SPAM', 'TRASH', 'DRAFT', 'CHAT')
    )) OR (${messageAlias}.labels_json IS NULL AND NOT EXISTS (
      SELECT 1 FROM thread_labels search_candidate_label
      WHERE search_candidate_label.account_id = ${messageAlias}.account_id
        AND search_candidate_label.thread_id = ${messageAlias}.thread_id
        AND search_candidate_label.label_id IN ('SPAM', 'TRASH', 'DRAFT', 'CHAT')
    )))`
}

function storedMessageHasAttachmentSql(messageAlias: string): string {
  return `COALESCE(${messageAlias}.attachments_json, '[]') <> '[]' AND EXISTS (
    SELECT 1 FROM json_each(COALESCE(${messageAlias}.attachments_json, '[]')) search_attachment
    WHERE COALESCE(json_extract(search_attachment.value, '$.inline'), 0) <> 1
  )`
}

/**
 * Full-format rows identify the exact message carrying an attachment. The
 * lifetime ids-only pass can only raise the thread flag, so use that flag only
 * when no stored message has exact attachment metadata yet.
 */
function messageHasAttachmentSql(messageAlias: string): string {
  return `((${storedMessageHasAttachmentSql(messageAlias)}) OR (
    t.has_attachment = 1 AND NOT EXISTS (
      SELECT 1 FROM messages search_known_attachment
      WHERE search_known_attachment.account_id = ${messageAlias}.account_id
        AND search_known_attachment.thread_id = ${messageAlias}.thread_id
        AND (${storedMessageHasAttachmentSql('search_known_attachment')})
    )
  ))`
}

function pendingSnoozeSql(): string {
  return `EXISTS (
    SELECT 1 FROM reminders search_snooze
    WHERE search_snooze.account_id = t.account_id AND search_snooze.thread_id = t.id
      AND search_snooze.kind = 'snooze' AND search_snooze.state = 'pending'
  )`
}

function messageLocationSql(value: string, messageAlias: string, values: unknown[]): string {
  const mailbox = systemMailboxName(value)
  if (mailbox === 'draft' || mailbox === 'drafts') return '0'
  if (mailbox === 'inbox') {
    return `${messageHasLabelSql(messageAlias, 'INBOX')} AND t.is_inbox_visible = 1`
  }
  if (mailbox === 'all' || mailbox === 'allmail') return normalMessageSql(messageAlias)
  if (mailbox === 'sent') {
    return `${messageHasLabelSql(messageAlias, 'SENT')} AND (${normalMessageSql(messageAlias)})`
  }
  if (mailbox === 'starred') {
    return `${messageHasLabelSql(messageAlias, 'STARRED')} AND (${normalMessageSql(messageAlias)})`
  }
  if (mailbox === 'snoozed') return `(${normalMessageSql(messageAlias)}) AND (${pendingSnoozeSql()})`
  if (mailbox === 'spam') return messageHasLabelSql(messageAlias, 'SPAM')
  if (mailbox === 'trash') return messageHasLabelSql(messageAlias, 'TRASH')
  values.push(value, value)
  return `EXISTS (
    SELECT 1 FROM labels search_catalog
    WHERE search_catalog.account_id = ${messageAlias}.account_id
      AND lower(search_catalog.type) = 'user'
      AND (search_catalog.name = ? COLLATE NOCASE OR search_catalog.id = ? COLLATE NOCASE)
      AND (${messageHasLabelExpressionSql(messageAlias, 'search_catalog.id')})
  ) AND (${normalMessageSql(messageAlias)})`
}

function messageFilterSql(filter: SearchFilter, messageAlias: string, values: unknown[]): string {
  if (filter.kind === 'is') {
    if (filter.value === 'unread') return messageHasLabelSql(messageAlias, 'UNREAD')
    if (filter.value === 'starred') return messageHasLabelSql(messageAlias, 'STARRED')
    return pendingSnoozeSql()
  }
  if (filter.kind === 'has') return messageHasAttachmentSql(messageAlias)
  if (filter.kind === 'in') return messageLocationSql(filter.value, messageAlias, values)
  values.push(searchDateMilliseconds(filter.value))
  return `COALESCE(${messageAlias}.internal_date, 0) ${filter.kind === 'before' ? '<' : '>='} ?`
}

function candidateSql(
  parsed: ParsedSearchQuery,
  match: string | null,
  accountId: string,
  values: unknown[]
): string {
  const messageAlias = 'search_message'
  const hasLocationFilter = parsed.filters.some((filter) => filter.kind === 'in')
  const filterOrder: Record<SearchFilter['kind'], number> = {
    before: 0,
    after: 0,
    in: 1,
    is: 2,
    has: 3
  }
  const orderedFilters = [...parsed.filters].sort(
    (left, right) => filterOrder[left.kind] - filterOrder[right.kind]
  )
  const predicates = [
    ...(!hasLocationFilter ? [normalMessageSql(messageAlias)] : []),
    ...orderedFilters.map((filter) => messageFilterSql(filter, messageAlias, values))
  ]
  if (match) {
    values.unshift(match, accountId, accountId)
    return `SELECT ${messageAlias}.thread_id, MIN(message_fts.rank) AS score
      FROM message_fts
      JOIN message_fts_map map ON map.fts_rowid = message_fts.rowid
      JOIN messages ${messageAlias}
        ON ${messageAlias}.account_id = map.account_id AND ${messageAlias}.id = map.message_id
      JOIN threads t ON t.account_id = ${messageAlias}.account_id AND t.id = ${messageAlias}.thread_id
      WHERE message_fts MATCH ? AND map.account_id = ? AND message_fts.account_id = ?
        ${predicates.map((predicate) => `AND (${predicate})`).join(' ')}
      GROUP BY ${messageAlias}.thread_id`
  }
  values.unshift(accountId)
  return `SELECT ${messageAlias}.thread_id, 0.0 AS score
    FROM messages ${messageAlias}
    JOIN threads t ON t.account_id = ${messageAlias}.account_id AND t.id = ${messageAlias}.thread_id
    WHERE ${messageAlias}.account_id = ?
      ${predicates.map((predicate) => `AND (${predicate})`).join(' ')}
    GROUP BY ${messageAlias}.thread_id`
}

function labelIds(value: string): string[] {
  return value ? value.split('\u001f') : []
}

function draftLocationOnly(parsed: ParsedSearchQuery): boolean {
  const locations = parsed.filters.filter((filter) => filter.kind === 'in')
  return (
    locations.length > 0 &&
    locations.every((filter) => {
      const mailbox = systemMailboxName(filter.value)
      return mailbox === 'draft' || mailbox === 'drafts'
    })
  )
}

function searchesDrafts(parsed: ParsedSearchQuery): boolean {
  return parsed.filters.some((filter) => {
    if (filter.kind !== 'in') return false
    const mailbox = systemMailboxName(filter.value)
    return mailbox === 'draft' || mailbox === 'drafts'
  })
}

function draftText(draft: Draft, field: SearchTextTerm['field'], accountId: string): string {
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
    .flatMap((address) => [address.name, address.email])
    .join(' ')
  if (field === 'from') return accountId
  if (field === 'to') return recipients
  if (field === 'subject') return draft.subject
  return [
    draft.subject,
    draft.bodyText,
    recipients,
    ...draft.attachments.map((attachment) => attachment.filename)
  ].join(' ')
}

function draftMatchesTerm(draft: Draft, term: SearchTextTerm, accountId: string): boolean {
  const haystack = draftText(draft, term.field, accountId).toLocaleLowerCase()
  return haystack.includes(term.value.toLocaleLowerCase())
}

function draftMatchesFilter(draft: Draft, filter: SearchFilter): boolean {
  if (filter.kind === 'in') {
    const mailbox = systemMailboxName(filter.value)
    return mailbox === 'draft' || mailbox === 'drafts'
  }
  if (filter.kind === 'is') return false
  if (filter.kind === 'has') return draft.attachments.some((attachment) => attachment.inline !== true)
  const boundary = searchDateMilliseconds(filter.value)
  return filter.kind === 'before' ? draft.updatedAt < boundary : draft.updatedAt >= boundary
}

function searchDraftRows(db: Db, accountId: string, parsed: ParsedSearchQuery, limit: number): Draft[] {
  if (!draftLocationOnly(parsed)) return []
  return listDrafts(db, accountId)
    .filter(
      (draft) =>
        parsed.terms.every((term) => draftMatchesTerm(draft, term, accountId)) &&
        parsed.filters.every((filter) => draftMatchesFilter(draft, filter))
    )
    .slice(0, limit)
}

function junkProjection(parsed: ParsedSearchQuery): 'SPAM' | 'TRASH' | null {
  const mailboxes = parsed.filters
    .filter((filter) => filter.kind === 'in')
    .map((filter) => systemMailboxName(filter.value))
  if (mailboxes.includes('spam')) return 'SPAM'
  if (mailboxes.includes('trash')) return 'TRASH'
  return null
}

function threadProjectionSql(junkLabel: 'SPAM' | 'TRASH' | null): string {
  if (!junkLabel) {
    return `t.from_display, t.subject, t.snippet, t.last_msg_at,
            t.is_unread, t.is_starred, t.has_attachment`
  }
  const visible = messageHasLabelSql('projection_message', junkLabel)
  const latest = (column: string): string => `(SELECT projection_message.${column}
    FROM messages projection_message
    WHERE projection_message.account_id = t.account_id AND projection_message.thread_id = t.id
      AND (${visible})
    ORDER BY COALESCE(projection_message.internal_date, 0) DESC, projection_message.id DESC
    LIMIT 1)`
  return `CASE
            WHEN lower(trim(COALESCE(${latest('from_email')}, ''))) = lower(trim(t.account_id)) THEN 'Me'
            ELSE COALESCE(NULLIF(${latest('from_name')}, ''), ${latest('from_email')}, '')
          END AS from_display,
          t.subject,
          COALESCE(${latest('snippet')}, '') AS snippet,
          COALESCE(${latest('internal_date')}, 0) AS last_msg_at,
          EXISTS (
            SELECT 1 FROM messages projection_message
            WHERE projection_message.account_id = t.account_id AND projection_message.thread_id = t.id
              AND (${visible}) AND (${messageHasLabelSql('projection_message', 'UNREAD')})
          ) AS is_unread,
          EXISTS (
            SELECT 1 FROM messages projection_message
            WHERE projection_message.account_id = t.account_id AND projection_message.thread_id = t.id
              AND (${visible}) AND (${messageHasLabelSql('projection_message', 'STARRED')})
          ) AS is_starred,
          EXISTS (
            SELECT 1 FROM messages projection_message
            WHERE projection_message.account_id = t.account_id AND projection_message.thread_id = t.id
              AND (${visible}) AND (${messageHasAttachmentSql('projection_message')})
          ) AS has_attachment`
}

/** Project provider-ordered thread ids into the same row shape as local search. */
export function searchRowsByThreadIds(
  db: Db,
  accountId: string,
  threadIds: readonly string[],
  query: string
): ThreadRow[] {
  const orderedIds = [...new Set(threadIds)].slice(0, SEARCH_RESULT_LIMIT)
  if (orderedIds.length === 0) return []
  const requested = orderedIds.map(() => '(?, ?)').join(', ')
  const requestedValues = orderedIds.flatMap((id, position) => [id, position])
  const projection = threadProjectionSql(junkProjection(parseSearchQuery(query)))
  const rows = db
    .prepare(
      `WITH requested(id, position) AS (VALUES ${requested})
       SELECT t.id, ${projection},
              EXISTS (
                SELECT 1 FROM reminders returned_reminder
                WHERE returned_reminder.account_id = t.account_id
                  AND returned_reminder.thread_id = t.id
                  AND returned_reminder.kind = 'snooze' AND returned_reminder.state = 'returned'
              ) AS returned,
              EXISTS (
                SELECT 1 FROM outbox draft
                WHERE draft.account_id = t.account_id AND draft.thread_id = t.id
                  AND draft.state IN ('composing', 'drafted')
              ) AS has_draft,
              COALESCE((
                SELECT GROUP_CONCAT(labels.label_id, char(31))
                FROM thread_labels labels
                WHERE labels.account_id = t.account_id AND labels.thread_id = t.id
              ), '') AS label_ids
       FROM requested
       JOIN threads t ON t.account_id = ? AND t.id = requested.id
       ORDER BY requested.position`
    )
    .all(...requestedValues, accountId) as SearchThreadRow[]
  return rows.map(toThreadRow)
}

/** Return only requested ids that the current local index already matches. */
export function matchingStoredThreadIds(
  db: Db,
  accountId: string,
  query: string,
  threadIds: readonly string[]
): Set<string> {
  const requestedIds = [...new Set(threadIds)].slice(0, SEARCH_RESULT_LIMIT)
  if (requestedIds.length === 0) return new Set()
  const parsed = parseSearchQuery(query)
  const match = searchMatchExpression(parsed)
  if ((!match && parsed.filters.length === 0) || searchesDrafts(parsed)) return new Set()

  const values: unknown[] = []
  const candidates = candidateSql(parsed, match, accountId, values)
  const requested = requestedIds.map(() => '(?)').join(', ')
  const rows = db
    .prepare(
      `WITH search_candidates AS (${candidates}), requested(id) AS (VALUES ${requested})
       SELECT candidates.thread_id AS id
       FROM search_candidates candidates
       JOIN requested ON requested.id = candidates.thread_id`
    )
    .all(...values, ...requestedIds) as Array<{ id: string }>
  return new Set(rows.map((row) => row.id))
}

/** Run local thread and Drafts search over their authoritative stores. */
export function searchThreads(
  db: Db,
  accountId: string,
  query: string,
  limit = SEARCH_RESULT_LIMIT
): SearchResponse {
  const parsed = parseSearchQuery(query)
  const match = searchMatchExpression(parsed)
  const coverage = searchCoverage(db, accountId)
  const resultLimit = Math.max(1, Math.min(Math.trunc(limit), SEARCH_RESULT_LIMIT))
  if (!query.trim() || (!match && parsed.filters.length === 0)) return { rows: [], drafts: [], coverage }

  if (searchesDrafts(parsed)) {
    return { rows: [], drafts: searchDraftRows(db, accountId, parsed, resultLimit), coverage }
  }

  const values: unknown[] = []
  const candidates = candidateSql(parsed, match, accountId, values)
  values.push(accountId, resultLimit)
  const projection = threadProjectionSql(junkProjection(parsed))
  const rows = db
    .prepare(
      `WITH search_candidates AS (${candidates})
       SELECT t.id, ${projection},
              EXISTS (
                SELECT 1 FROM reminders returned_reminder
                WHERE returned_reminder.account_id = t.account_id
                  AND returned_reminder.thread_id = t.id
                  AND returned_reminder.kind = 'snooze' AND returned_reminder.state = 'returned'
              ) AS returned,
              EXISTS (
                SELECT 1 FROM outbox draft
                WHERE draft.account_id = t.account_id AND draft.thread_id = t.id
                  AND draft.state IN ('composing', 'drafted')
              ) AS has_draft,
              COALESCE((
                SELECT GROUP_CONCAT(labels.label_id, char(31))
                FROM thread_labels labels
                WHERE labels.account_id = t.account_id AND labels.thread_id = t.id
              ), '') AS label_ids
       FROM search_candidates candidates
       JOIN threads t ON t.id = candidates.thread_id
       WHERE t.account_id = ?
       ORDER BY COALESCE(last_msg_at, 0) DESC, candidates.score, t.id
       LIMIT ?`
    )
    .all(...values) as SearchThreadRow[]

  return {
    rows: rows.map(toThreadRow),
    drafts: [],
    coverage
  }
}
