// Read queries for the renderer. Plain Node module (no Electron imports).

import { isValidEmail, normalizeEmailKey } from '../../shared/address'
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
  MessageRecipients,
  SnoozedThreadRow,
  SystemMailboxCounts,
  ThreadListView,
  ThreadPageCursor,
  ThreadRow
} from '../../shared/mail'
import { messageLabelsMatchMailbox } from '../../shared/mail'
import { splitAssignmentForAccount } from '../splits'
import { needsBodyHydration } from '../sync/bodyHydration'
import { THREAD_LIST_LIMIT } from '../sync/tuning'
import type { Db } from './index'
import { storedMessageLabelSql, threadLabelSql } from './labelSql'
import type { MaterializedMailboxView } from './mailboxMembership'
import {
  labelIds,
  labelIdsProjectionSql,
  THREAD_AUXILIARY_PROJECTION_SQL,
  type ThreadProjectionRow,
  toThreadRow
} from './threadRows'

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

function descendingCursorSql(sortExpression: string, cursor: ThreadPageCursor | null): string {
  return cursor ? `AND (${sortExpression} < ? OR (${sortExpression} = ? AND t.id > ?))` : ''
}

function ascendingCursorSql(sortExpression: string, cursor: ThreadPageCursor | null): string {
  return cursor ? `AND (${sortExpression} > ? OR (${sortExpression} = ? AND t.id > ?))` : ''
}

function cursorValues(cursor: ThreadPageCursor | null): [number, number, string] | [] {
  return cursor ? [cursor.at, cursor.at, cursor.id] : []
}

/** Membership SQL below joins `threads t` and tests `messages m` against it. */
const THREAD_KEY = { accountId: 't.account_id', id: 't.id' }
const storedLabelSql = (label: string): string => storedMessageLabelSql('m', `'${label}'`)
const HIDDEN_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT']
const HIDDEN_STORED_LABELS_SQL = HIDDEN_LABELS.map((label) => storedLabelSql(label)).join(' OR ')
const HIDDEN_FALLBACK_LABELS_SQL = HIDDEN_LABELS.map((label) =>
  threadLabelSql(THREAD_KEY, `'${label}'`)
).join(' OR ')

export function allMailMembershipSql(): string {
  const junkThreadLabels = ['SPAM', 'TRASH']
    .map((label) => threadLabelSql(THREAD_KEY, `'${label}'`))
    .join(' OR ')
  return `(NOT (${junkThreadLabels}) AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id AND m.thread_id = t.id
    )) OR EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id AND m.thread_id = t.id
        AND ((m.labels_json IS NOT NULL AND NOT (${HIDDEN_STORED_LABELS_SQL}))
             OR (m.labels_json IS NULL AND NOT (${HIDDEN_FALLBACK_LABELS_SQL})))
    )`
}

/**
 * Sent and Starred membership: some message carries the mailbox label and would
 * render in the normal reader — junk (SPAM/TRASH) and never-rendered (DRAFT and
 * legacy CHAT) messages do not represent a thread here, so a reply chain whose
 * only sent copy was trashed leaves Sent. Legacy rows without labels_json fall
 * back to thread-level labels, mirroring the reader's legacy behavior.
 */
export function labeledMailboxMembershipSql(labelExpression = 'mailbox.label_id'): string {
  return `EXISTS (
      SELECT 1 FROM messages m
      WHERE m.account_id = t.account_id AND m.thread_id = t.id
        AND ((m.labels_json IS NOT NULL
              AND ${storedMessageLabelSql('m', labelExpression)}
              AND NOT (${HIDDEN_STORED_LABELS_SQL}))
             OR (m.labels_json IS NULL AND NOT (${HIDDEN_FALLBACK_LABELS_SQL})))
    )`
}

/** Mailbox list views whose membership derives from label rules rather than a dedicated query. */
export type LabelMailboxView = Exclude<ThreadListView, 'inbox' | 'snoozed'>

const MAILBOX_LABEL_IDS = {
  sent: 'SENT',
  starred: 'STARRED',
  spam: 'SPAM',
  trash: 'TRASH'
} as const

const THREAD_PROJECTION_SQL = `t.account_id, t.id, t.from_display, t.subject, t.snippet,
                t.is_unread, t.is_starred, t.has_attachment,
              ${THREAD_AUXILIARY_PROJECTION_SQL}`

interface MailboxThreadQueryRow extends ThreadProjectionRow {
  account_id: string
  mailbox_last_msg_at: number | null
}

/**
 * The S2 membership rules as list surfaces (SPEC F3): Spam and Trash include a
 * thread when any message carries the label and sort by that mailbox's newest
 * matching message; All Mail includes a thread when any message is outside Spam
 * and Trash; Sent and Starred apply the normal reader's junk exclusion.
 */
export function listMailboxThreads(
  db: Db,
  accountId: string,
  view: LabelMailboxView,
  limit = THREAD_LIST_LIMIT,
  cursor: ThreadPageCursor | null = null,
  threadId?: string
): ThreadRow[] {
  const wrap = (visibleSql: string): string =>
    `WITH visible AS (${visibleSql})
     SELECT v.*, ${labelIdsProjectionSql('v')}
     FROM visible v
     ORDER BY v.mailbox_last_msg_at DESC, v.id`
  let rows: MailboxThreadQueryRow[]
  if (view === 'allMail') {
    // Paged from `thread_mailboxes`: its index already holds this view in sort
    // order, so a page is a range read instead of a membership test against every
    // thread in the account. A saved selection needs the thread-key index instead:
    // the recency index cannot constrain thread_id after its sort_at column.
    const sortExpression = 'mailbox.sort_at'
    rows = db
      .prepare(
        wrap(`SELECT ${THREAD_PROJECTION_SQL}, mailbox.sort_at AS mailbox_last_msg_at
              FROM thread_mailboxes mailbox ${threadId ? '' : 'INDEXED BY idx_thread_mailboxes_recent'}
              JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
              WHERE mailbox.account_id = ? AND mailbox.view = 'allMail'
                ${threadId ? 'AND mailbox.thread_id = ?' : ''}
                ${descendingCursorSql(sortExpression, cursor)}
              ORDER BY mailbox_last_msg_at DESC, t.id
              LIMIT ?`)
      )
      .all(
        accountId,
        ...(threadId ? [threadId] : []),
        ...cursorValues(cursor),
        limit
      ) as MailboxThreadQueryRow[]
  } else if (view === 'spam' || view === 'trash') {
    const sortExpression = 'summary.mailbox_last_msg_at'
    rows = db
      .prepare(
        `WITH candidate AS (
           SELECT m.*,
                  CASE WHEN m.labels_json IS NULL OR EXISTS (
                    SELECT 1 FROM json_each(m.labels_json) stored
                    WHERE stored.value = mailbox.label_id
                  ) THEN 1 ELSE 0 END AS matches_mailbox
           FROM thread_labels mailbox INDEXED BY idx_thread_labels_label
           JOIN messages m INDEXED BY idx_messages_thread
             ON m.account_id = mailbox.account_id AND m.thread_id = mailbox.thread_id
           WHERE mailbox.account_id = ? AND mailbox.label_id = ?
             ${threadId ? 'AND m.thread_id = ?' : ''}
         ),
         classified AS (
           SELECT candidate.*,
                  MAX(matches_mailbox) OVER (PARTITION BY account_id, thread_id)
                    AS has_mailbox_message
           FROM candidate
         ),
         matching AS (
           SELECT classified.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY account_id, thread_id
                    ORDER BY COALESCE(internal_date, 0) DESC, id DESC
                  ) AS mailbox_rank
           FROM classified
           WHERE matches_mailbox = 1 OR (has_mailbox_message = 0 AND NOT EXISTS (
             SELECT 1 FROM json_each(COALESCE(labels_json, '[]')) stored
             WHERE stored.value IN ('DRAFT', 'CHAT')
           ))
         ),
         summary AS (
           SELECT account_id, thread_id,
                  MAX(COALESCE(internal_date, 0)) AS mailbox_last_msg_at,
                  MAX(labels_json IS NULL) AS has_legacy_labels,
                  MAX(CASE WHEN labels_json IS NOT NULL AND EXISTS (
                    SELECT 1 FROM json_each(labels_json) stored WHERE stored.value = 'UNREAD'
                  ) THEN 1 ELSE 0 END) AS is_unread,
                  MAX(CASE WHEN labels_json IS NOT NULL AND EXISTS (
                    SELECT 1 FROM json_each(labels_json) stored WHERE stored.value = 'STARRED'
                  ) THEN 1 ELSE 0 END) AS is_starred,
                  MAX(CASE WHEN EXISTS (
                    SELECT 1 FROM json_each(COALESCE(attachments_json, '[]')) attachment
                    WHERE COALESCE(json_extract(attachment.value, '$.inline'), 0) <> 1
                  ) THEN 1 ELSE 0 END) AS has_attachment
           FROM matching
           GROUP BY account_id, thread_id
         ),
         visible AS (
           SELECT t.account_id, t.id,
                  CASE
                    WHEN lower(trim(COALESCE(latest.from_email, ''))) = lower(trim(account.email))
                      THEN 'Me'
                    ELSE COALESCE(NULLIF(latest.from_name, ''), latest.from_email, '')
                  END AS from_display,
                  t.subject, COALESCE(latest.snippet, '') AS snippet,
                  CASE WHEN summary.has_legacy_labels = 1 THEN t.is_unread ELSE summary.is_unread END
                    AS is_unread,
                  CASE WHEN summary.has_legacy_labels = 1 THEN t.is_starred ELSE summary.is_starred END
                    AS is_starred,
                  summary.has_attachment,
                  ${THREAD_AUXILIARY_PROJECTION_SQL},
                  summary.mailbox_last_msg_at
           FROM summary
           JOIN threads t ON t.account_id = summary.account_id AND t.id = summary.thread_id
           LEFT JOIN accounts account ON account.id = t.account_id
           JOIN matching latest
             ON latest.account_id = summary.account_id AND latest.thread_id = summary.thread_id
            AND latest.mailbox_rank = 1
           WHERE 1 = 1 ${descendingCursorSql(sortExpression, cursor)}
           ORDER BY summary.mailbox_last_msg_at DESC, t.id
           LIMIT ?
         )
         SELECT v.*, ${labelIdsProjectionSql('v')}
         FROM visible v
         ORDER BY v.mailbox_last_msg_at DESC, v.id`
      )
      .all(
        accountId,
        MAILBOX_LABEL_IDS[view],
        ...(threadId ? [threadId] : []),
        ...cursorValues(cursor),
        limit
      ) as MailboxThreadQueryRow[]
  } else {
    const sortExpression = 'COALESCE(t.last_msg_at, 0)'
    rows = db
      .prepare(
        wrap(`SELECT ${THREAD_PROJECTION_SQL}, ${sortExpression} AS mailbox_last_msg_at
              FROM thread_labels mailbox INDEXED BY idx_thread_labels_label
              JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
              WHERE mailbox.account_id = ? AND mailbox.label_id = ?
                AND (${labeledMailboxMembershipSql()})
                ${threadId ? 'AND t.id = ?' : ''}
                ${descendingCursorSql(sortExpression, cursor)}
              ORDER BY mailbox_last_msg_at DESC, t.id
              LIMIT ?`)
      )
      .all(
        accountId,
        MAILBOX_LABEL_IDS[view],
        ...(threadId ? [threadId] : []),
        ...cursorValues(cursor),
        limit
      ) as MailboxThreadQueryRow[]
  }
  return rows.map((r) => toThreadRow(r, r.mailbox_last_msg_at))
}

/**
 * User-label views use the same normal-reader rules as Sent and Starred. A
 * trashed or spammed copy cannot pull an otherwise unrelated conversation into
 * the view, and the label id must still exist in the account's user catalog.
 */
export function listLabelThreads(
  db: Db,
  accountId: string,
  labelId: string,
  limit = THREAD_LIST_LIMIT,
  cursor: ThreadPageCursor | null = null,
  threadId?: string
): ThreadRow[] {
  const sortExpression = 'COALESCE(t.last_msg_at, 0)'
  const rows = db
    .prepare(
      `WITH visible AS (
         SELECT ${THREAD_PROJECTION_SQL}, ${sortExpression} AS mailbox_last_msg_at
         FROM labels catalog
         JOIN thread_labels mailbox
           ON mailbox.account_id = catalog.account_id AND mailbox.label_id = catalog.id
         JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
         WHERE catalog.account_id = ? AND catalog.id = ? AND lower(catalog.type) = 'user'
           AND (${labeledMailboxMembershipSql()})
           ${threadId ? 'AND t.id = ?' : ''}
           ${descendingCursorSql(sortExpression, cursor)}
         ORDER BY mailbox_last_msg_at DESC, t.id
         LIMIT ?
       )
       SELECT v.*, ${labelIdsProjectionSql('v')}
       FROM visible v
       ORDER BY v.mailbox_last_msg_at DESC, v.id`
    )
    .all(
      accountId,
      labelId,
      ...(threadId ? [threadId] : []),
      ...cursorValues(cursor),
      limit
    ) as MailboxThreadQueryRow[]

  return rows.map((r) => toThreadRow(r, r.mailbox_last_msg_at))
}

export function listInboxThreads(
  db: Db,
  accountId: string,
  limit = THREAD_LIST_LIMIT,
  cursor: ThreadPageCursor | null = null,
  splitId?: string,
  threadId?: string
): ThreadRow[] {
  const assignment = splitId ? splitAssignmentForAccount(db, accountId) : null
  const splitFilter = assignment ? `AND (${assignment.sql}) = ?` : ''
  const readRows = (
    pageLimit: number,
    recent: boolean,
    undatedTail = false,
    pageCursor: ThreadPageCursor | null = null
  ) => {
    const sortExpression = recent ? 't.last_msg_at' : 'COALESCE(t.last_msg_at, 0)'
    return db
      .prepare(
        `WITH visible AS (
         SELECT t.account_id, t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
                t.is_unread, t.is_starred, t.has_attachment,
              ${THREAD_AUXILIARY_PROJECTION_SQL}
         FROM threads t ${recent ? 'INDEXED BY idx_threads_recent' : ''}
         ${recent ? 'CROSS JOIN' : 'JOIN'} thread_labels inbox
           ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
         WHERE t.account_id = ? AND t.is_inbox_visible = 1
           ${recent ? 'AND t.last_msg_at > 0' : ''}
           ${undatedTail ? 'AND (t.last_msg_at IS NULL OR t.last_msg_at <= 0)' : ''}
           ${splitFilter}
           ${threadId ? 'AND t.id = ?' : FOLLOW_UP_TIER_EXCLUSION_SQL}
           ${descendingCursorSql(sortExpression, pageCursor)}
         ORDER BY ${sortExpression} DESC, t.id
         LIMIT ?
       )
       SELECT v.*, ${labelIdsProjectionSql('v')}
       FROM visible v
       ORDER BY COALESCE(v.last_msg_at, 0) DESC, v.id`
      )
      .all(
        accountId,
        ...(assignment ? [...assignment.params, splitId] : []),
        ...(threadId ? [threadId] : []),
        ...cursorValues(pageCursor),
        pageLimit
      ) as (ThreadProjectionRow & { account_id: string; last_msg_at: number | null })[]
  }

  // Returned follow-ups sort above normal mail until triaged (F9). The tier
  // pages by its own due_at keyset — a page boundary inside it continues with
  // a `tier` cursor (PR #101 review: prepending it wholesale silently dropped
  // every returned follow-up past the first page) — and once it is exhausted
  // the dated mailbox flow starts from its beginning, with tier rows excluded
  // there so pagination never duplicates or skips a row.
  const tierPhase = !threadId && (!cursor || cursor.tier === 'followUp')
  const tier = tierPhase
    ? readFollowUpTier(db, accountId, assignment ? { assignment, splitId } : null, limit, cursor)
    : []
  const mailCursor = tierPhase ? null : cursor
  const mailLimit = Math.max(0, limit - tier.length)
  // COALESCE prevents SQLite from using the date index for ordering, so it
  // classifies the entire account before LIMIT. Read positive dates directly
  // from that index, then preserve the original null-as-zero order in the tail.
  // Targeted membership checks retain their primary-key lookup.
  const recent = !threadId && mailLimit > 0 && (!mailCursor || mailCursor.at > 0)
  const rows = mailLimit > 0 ? readRows(mailLimit, recent, false, mailCursor) : []
  if (recent && rows.length < mailLimit) {
    rows.push(...readRows(mailLimit - rows.length, false, true, mailCursor))
  }

  return [...tier, ...rows.map((r) => toThreadRow(r, r.last_msg_at))]
}

const FOLLOW_UP_TIER_EXCLUSION_SQL = `AND NOT EXISTS (
             SELECT 1 FROM reminders fr
             WHERE fr.account_id = t.account_id AND fr.thread_id = t.id
               AND fr.kind = 'follow_up' AND fr.state = 'returned')`

/**
 * The above-normal tier: returned follow-ups in this inbox view (F9), paged by
 * their own (due_at, id) keyset. Rows carry `followUpTierAt` so a page boundary
 * inside the tier emits a `tier: 'followUp'` cursor rather than a dated one.
 */
function readFollowUpTier(
  db: Db,
  accountId: string,
  split: { assignment: { sql: string; params: unknown[] }; splitId: string | undefined } | null,
  limit: number,
  cursor: ThreadPageCursor | null
): ThreadRow[] {
  if (limit <= 0) return []
  const rows = db
    .prepare(
      `WITH visible AS (
         SELECT ${THREAD_PROJECTION_SQL}, COALESCE(t.last_msg_at, 0) AS mailbox_last_msg_at, fr.due_at
         FROM reminders fr
         JOIN threads t ON t.account_id = fr.account_id AND t.id = fr.thread_id
         JOIN thread_labels inbox
           ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
         WHERE fr.account_id = ? AND fr.kind = 'follow_up' AND fr.state = 'returned'
           AND t.is_inbox_visible = 1
           ${split ? `AND (${split.assignment.sql}) = ?` : ''}
           ${descendingCursorSql('fr.due_at', cursor)}
         ORDER BY fr.due_at DESC, t.id
         LIMIT ?
       )
       SELECT v.*, ${labelIdsProjectionSql('v')}
       FROM visible v
       ORDER BY v.due_at DESC, v.id`
    )
    .all(
      accountId,
      ...(split ? [...split.assignment.params, split.splitId] : []),
      ...cursorValues(cursor),
      limit
    ) as (MailboxThreadQueryRow & { due_at: number })[]
  return rows.map((r) => ({
    ...toThreadRow(r, r.mailbox_last_msg_at),
    followUpReturned: true,
    followUpTierAt: r.due_at
  }))
}

/**
 * The Snoozed/Reminders view lists every thread with a pending reminder of
 * either kind (F4/F9): one row per thread, showing both deadlines and — for a
 * follow-up that has not fired — whether it waits on a snooze return or on an
 * unresolved origin check. Sorted by the earliest pending deadline.
 */
export function listSnoozedThreads(
  db: Db,
  accountId: string,
  limit = THREAD_LIST_LIMIT,
  cursor: ThreadPageCursor | null = null,
  threadId?: string
): SnoozedThreadRow[] {
  const rows = db
    .prepare(
      `WITH live AS (
         SELECT account_id, thread_id,
                MIN(CASE WHEN kind = 'snooze' THEN due_at END) AS snooze_due,
                MIN(CASE WHEN kind = 'follow_up' THEN due_at END) AS follow_up_due,
                MAX(CASE WHEN kind = 'follow_up' AND origin_internal_date IS NULL THEN 1 ELSE 0 END)
                  AS follow_up_origin_pending,
                MIN(due_at) AS due_at
         FROM reminders
         WHERE account_id = ? AND state = 'pending' AND kind IN ('snooze', 'follow_up')
         GROUP BY account_id, thread_id
       ),
       visible AS (
         SELECT t.account_id, t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
                t.is_unread, t.is_starred, t.has_attachment,
                live.due_at, live.snooze_due, live.follow_up_due, live.follow_up_origin_pending,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft
         FROM live
         JOIN threads t ON t.account_id = live.account_id AND t.id = live.thread_id
         WHERE 1 = 1
           ${threadId ? 'AND t.id = ?' : ''}
           ${ascendingCursorSql('live.due_at', cursor)}
         ORDER BY live.due_at ASC, t.id
         LIMIT ?
       )
       SELECT v.*, ${labelIdsProjectionSql('v')}
       FROM visible v
       ORDER BY v.due_at ASC, v.id`
    )
    .all(accountId, ...(threadId ? [threadId] : []), ...cursorValues(cursor), limit) as {
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
    snooze_due: number | null
    follow_up_due: number | null
    follow_up_origin_pending: number
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
    snoozed: r.snooze_due !== null,
    returned: false,
    hasDraft: r.has_draft === 1,
    labelIds: labelIds(r.label_ids),
    dueAt: r.due_at,
    snoozeDueAt: r.snooze_due,
    followUpDueAt: r.follow_up_due,
    followUpAwaiting:
      r.follow_up_due === null
        ? null
        : r.follow_up_origin_pending === 1
          ? 'origin'
          : r.snooze_due !== null
            ? 'snooze'
            : null
  }))
}

/**
 * Exact local totals using the same membership rules as each system mailbox list.
 *
 * Inbox, All Mail, Sent and Starred read `thread_mailboxes`, where counting is a
 * range read over one index rather than a membership scan of the account: at
 * 800,000 threads that is the difference between 584 ms and 10 ms for All Mail.
 * Spam and Trash keep the label index, because their membership is message-level
 * and Gmail purges both at about 30 days, so neither grows into a scan.
 */
export function countSystemMailboxes(db: Db, accountId: string): SystemMailboxCounts {
  const materialized = db.prepare(
    'SELECT COUNT(*) AS count FROM thread_mailboxes WHERE account_id = ? AND view = ?'
  )
  const materializedCount = (view: MaterializedMailboxView): number =>
    (materialized.get(accountId, view) as { count: number }).count

  const junkCount = (view: 'spam' | 'trash'): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM thread_labels mailbox INDEXED BY idx_thread_labels_label
           JOIN threads t ON t.account_id = mailbox.account_id AND t.id = mailbox.thread_id
           WHERE mailbox.account_id = ? AND mailbox.label_id = ?`
        )
        .get(accountId, MAILBOX_LABEL_IDS[view]) as { count: number }
    ).count

  return {
    inbox: materializedCount('inbox'),
    allMail: materializedCount('allMail'),
    sent: materializedCount('sent'),
    starred: materializedCount('starred'),
    snoozed: (
      db
        .prepare(
          // Mirrors listSnoozedThreads' membership: one row per thread with a
          // pending reminder of either kind — DISTINCT because a thread can
          // hold both a snooze and a follow-up (T35/F9, PR #101 review).
          `SELECT COUNT(DISTINCT r.thread_id) AS count
           FROM reminders r
           JOIN threads t ON t.account_id = r.account_id AND t.id = r.thread_id
           WHERE r.account_id = ? AND r.kind IN ('snooze', 'follow_up') AND r.state = 'pending'`
        )
        .get(accountId) as { count: number }
    ).count,
    spam: junkCount('spam'),
    trash: junkCount('trash')
  }
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
      // Badge counts run on every mail change, so this seeks the INBOX label
      // index instead of scanning every thread in the account for the flag.
      `SELECT COUNT(*) AS count
       FROM thread_labels inbox INDEXED BY idx_thread_labels_label
       JOIN threads t ON t.account_id = inbox.account_id AND t.id = inbox.thread_id
       WHERE inbox.account_id = ? AND inbox.label_id = 'INBOX'
         AND t.is_inbox_visible = 1
         AND t.is_unread = 1`
    )
    .get(accountId) as { count: number }

  return row.count
}

/** The signed-in address. `account_id` doubles as the email in v1 (SPEC D4). */
function accountEmail(db: Db, accountId: string): string | undefined {
  return (
    db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as { email: string } | undefined
  )?.email
}

export function getConversation(
  db: Db,
  accountId: string,
  threadId: string,
  missingBodyState: Exclude<MessageBodyState, 'complete'>,
  mailbox: ConversationMailbox = 'normal',
  withTrashedMarkers = false
): Conversation | null {
  return readConversation(db, accountId, threadId, missingBodyState, mailbox, withTrashedMarkers)
}

function readConversation(
  db: Db,
  accountId: string,
  threadId: string,
  missingBodyState: Exclude<MessageBodyState, 'complete'>,
  mailbox: ConversationMailbox,
  withTrashedMarkers: boolean,
  selfAddress: string | undefined = accountEmail(db, accountId)
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
    trashed?: boolean
  }[]
  const selfEmail = normalizeEmailKey(selfAddress ?? accountId)

  const messages: ConversationMsg[] = rows
    .flatMap((row) => {
      if (messageVisibleInMailbox(row.labels_json, fallbackLabels, mailbox)) return [row]
      // Normal and All Mail readers keep each trashed message's chronological
      // position as a marker (SPEC F3). Spammed messages stay hidden, and a
      // legacy row without labels_json cannot be identified as trashed.
      const marks =
        withTrashedMarkers &&
        (mailbox === 'normal' || mailbox === 'all-mail') &&
        messageIsTrashedMarker(row.labels_json)
      return marks ? [{ ...row, trashed: true }] : []
    })
    .map((r) => ({
      ...(r.trashed ? { trashed: true } : {}),
      id: r.id,
      rfcMessageId: r.rfc_message_id,
      references: parseJson(r.references_json, []),
      fromName: r.from_email && normalizeEmailKey(r.from_email) === selfEmail ? 'Me' : (r.from_name ?? ''),
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
  mailbox: ConversationMailbox = 'normal',
  withTrashedMarkers = false
): Conversation | null {
  // One account read for both halves: the reader below needs the same address.
  const account = accountEmail(db, accountId)
  const conversation = readConversation(
    db,
    accountId,
    threadId,
    missingBodyState,
    mailbox,
    withTrashedMarkers,
    account
  )
  if (!conversation) return null
  if (mailbox === 'spam' || mailbox === 'trash') return conversation
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
            normalizeEmailKey(message.fromEmail) === normalizeEmailKey(account) &&
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
        fromEmail: account ?? accountId,
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
  const selfEmail = accountEmail(db, accountId) ?? accountId

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

/** Trashed but not spammed or never-rendered: the message earns a reader marker. */
function messageIsTrashedMarker(labelsJson: string | null): boolean {
  if (labelsJson === null) return false
  const labels = new Set(parseJson(labelsJson, [] as string[]))
  return labels.has('TRASH') && !labels.has('SPAM') && !labels.has('DRAFT') && !labels.has('CHAT')
}

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
