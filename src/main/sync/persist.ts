import { normalizeEmailKey } from '../../shared/address'
import { foldForSearch } from '../../shared/contacts'
import { messageLabelsMatchMailbox } from '../../shared/mail'
import type { Db } from '../db'
import { refreshThreadMailboxes, removeThreadMailboxes } from '../db/mailboxMembership'
import {
  collectAttachments,
  extractBodyHtml,
  extractBodyText,
  extractThreadingHeaders,
  type GmailMessage,
  type GmailThread,
  hasCalendarPart,
  header,
  parseAddress,
  parseAddressList
} from '../gmail/parse'
import { canonicalListId } from '../splits'
import { replaySnoozeReminderDelta } from '../store/reminders'
import { replayPendingThreadDeltas } from '../store/replay'
import { indexThreadMessages, removeThreadFromIndex } from './fts'

export interface LabelRow {
  id: string
  name: string
  type: string
}

export interface LabelCatalogPlan {
  upsert: LabelRow[]
  removeIds: string[]
}

/** Idempotently register an account row (account id doubles as the email in v1). */
export function ensureAccount(db: Db, accountId: string, email: string): void {
  db.prepare('INSERT OR IGNORE INTO accounts (id, email) VALUES (?, ?)').run(accountId, email)
}

/** Compare a stored catalog with one complete, authoritative provider listing. */
export function planLabelCatalogUpdate(
  existing: readonly LabelRow[],
  authoritative: readonly LabelRow[]
): LabelCatalogPlan {
  const existingById = new Map(existing.map((label) => [label.id, label]))
  const authoritativeById = new Map(authoritative.map((label) => [label.id, label]))
  return {
    upsert: [...authoritativeById.values()].filter((label) => {
      const stored = existingById.get(label.id)
      return !stored || stored.name !== label.name || stored.type !== label.type
    }),
    removeIds: [...existingById.keys()].filter((id) => !authoritativeById.has(id))
  }
}

/**
 * Replace the local catalog with an authoritative provider listing. Label
 * membership rows deliberately remain: history/reconciliation owns them.
 */
export function upsertLabels(db: Db, accountId: string, labels: LabelRow[]): boolean {
  const selectExisting = db.prepare('SELECT id, name, type FROM labels WHERE account_id = ?')
  const upsert = db.prepare(
    `INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type`
  )
  const remove = db.prepare('DELETE FROM labels WHERE account_id = ? AND id = ?')
  return db.transaction(() => {
    const existing = selectExisting.all(accountId) as LabelRow[]
    const plan = planLabelCatalogUpdate(existing, labels)
    if (plan.upsert.length === 0 && plan.removeIds.length === 0) return false
    for (const label of plan.upsert) upsert.run(accountId, label.id, label.name, label.type)
    for (const id of plan.removeIds) remove.run(accountId, id)
    return true
  })()
}

export interface PersistThreadOptions {
  metadataOnly?: boolean
  /**
   * Lifetime-only rows retain Gmail's labels without entering M2's bounded
   * Inbox surface, and `'preserve'` never changes that flag — including on an
   * insert, where there is no prior choice to keep and a thread the sweep has
   * not reached must not enter the surface through a label-only refetch or a
   * server-search store. Only `'show'` (a backfill or a fresh Inbox event) may
   * promote a thread into it.
   *
   * Omitting the option keeps a new row visible: those callers store an
   * authoritative snapshot of a thread the user is already acting on (action
   * recovery, the post-send refresh, an inline-image repair) or seed a
   * development store, none of which is bounded by the lifetime sweep. Server
   * search deliberately stays on that default even though it can store a thread
   * the sweep has not reached: its results are read back through the ordinary
   * queries, so an `in:inbox` match stored hidden would vanish from the very
   * result list that fetched it (`e2e/search.spec.ts`).
   */
  inboxVisibility?: 'hide' | 'preserve' | 'show'
}

export function nonDraftMessages(messages: readonly GmailMessage[]): GmailMessage[] {
  return messages.filter(
    (message) => !message.labelIds?.includes('DRAFT') && !message.labelIds?.includes('CHAT')
  )
}

/** Persist an authoritative Gmail thread snapshot through the production write path. */
export function persistThread(
  db: Db,
  accountId: string,
  thread: GmailThread,
  options: PersistThreadOptions = {}
): boolean {
  // Draft messages are represented by outbox rows. Persisting them here would
  // render unsent text as an ordinary conversation message once a threaded
  // Gmail draft appears in a thread snapshot.
  const messages = nonDraftMessages(thread.messages ?? [])
  if (messages.length === 0) {
    // An all-draft or legacy-Chat snapshot is still authoritative. Remove any
    // stale ordinary messages left behind when Gmail deleted the real mail.
    deleteThread(db, accountId, thread.id)
    return false
  }
  const normalMessages = messages.filter((message) =>
    messageLabelsMatchMailbox(new Set(message.labelIds ?? []), 'normal')
  )
  // Junk-only threads still need a useful summary for their future mailbox.
  // Mixed threads summarize the messages the normal reader can actually show.
  const summaryMessageIds = new Set(
    (normalMessages.length > 0 ? normalMessages : messages).map((message) => message.id)
  )

  const upsertMsg = db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                           body_text, body_html, recipients_json, attachments_json, labels_json,
                           list_id, has_calendar_part, rfc_message_id, references_json)
     VALUES (@account_id, @id, @thread_id, @from_name, @from_email, @snippet, @internal_date,
             @body_text, @body_html, @recipients_json,
             @attachments_json, @labels_json, @list_id, @has_calendar_part,
             @rfc_message_id, @references_json)
     ON CONFLICT(account_id, id) DO UPDATE SET
       snippet = excluded.snippet,
       body_text = CASE WHEN messages.body_text IS NULL OR messages.body_text = ''
                        THEN excluded.body_text ELSE messages.body_text END,
       body_html = CASE WHEN messages.body_html IS NULL OR messages.body_html = ''
                        THEN excluded.body_html ELSE messages.body_html END,
       recipients_json = excluded.recipients_json,
       attachments_json = CASE WHEN @metadata_only = 1
                               THEN messages.attachments_json ELSE excluded.attachments_json END,
       list_id = excluded.list_id,
       has_calendar_part = CASE WHEN @metadata_only = 1
                                THEN messages.has_calendar_part ELSE excluded.has_calendar_part END,
       labels_json = excluded.labels_json,
       rfc_message_id = excluded.rfc_message_id,
       references_json = excluded.references_json`
  )
  const upsertThread = db.prepare(
    `INSERT INTO threads (account_id, id, subject, snippet, last_msg_at,
                          from_display, is_unread, is_starred, has_attachment, is_inbox_visible)
     VALUES (@account_id, @id, @subject, @snippet, @last_msg_at,
             @from_display, @is_unread, @is_starred, @has_attachment, @insert_inbox_visible)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = excluded.subject, snippet = excluded.snippet,
       last_msg_at = excluded.last_msg_at, from_display = excluded.from_display,
       is_unread = excluded.is_unread, is_starred = excluded.is_starred,
       is_inbox_visible = CASE WHEN @promote_inbox_visible = 1
                               THEN 1 ELSE threads.is_inbox_visible END,
       has_attachment = CASE WHEN @metadata_only = 1
                             THEN threads.has_attachment ELSE excluded.has_attachment END`
  )
  const clearLabels = db.prepare('DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?')
  const insertLabel = db.prepare(
    'INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
  )
  const insertContactMessage = db.prepare(
    `INSERT OR IGNORE INTO contact_messages (account_id, message_id, email, role, name)
     VALUES (?, ?, ?, ?, ?)`
  )
  const existingMessageContacts = db.prepare(
    'SELECT email FROM contact_messages WHERE account_id = ? AND message_id = ?'
  )
  const clearMessageContacts = db.prepare(
    'DELETE FROM contact_messages WHERE account_id = ? AND message_id = ?'
  )
  const incomingMessageIds = messages.map((message) => message.id)

  const hidesNewRow = options.inboxVisibility === 'hide' || options.inboxVisibility === 'preserve'

  db.transaction(() => {
    const affectedContactEmails = new Set<string>()
    const labelUnion = new Set<string>()
    let lastMsgAt = 0
    let anyUnread = 0
    let anyStarred = 0
    let anyAttachment = 0
    let subject = ''
    let fromDisplay = ''
    let snippet = ''

    for (const msg of messages) {
      const from = parseAddress(header(msg, 'From'))
      const at = Number(msg.internalDate ?? 0)
      const unread = msg.labelIds?.includes('UNREAD') ? 1 : 0
      const attachments = collectAttachments(msg.payload)
      const attach = attachments.some((attachment) => !attachment.inline) ? 1 : 0
      const recipients = {
        to: parseAddressList(header(msg, 'To')),
        cc: parseAddressList(header(msg, 'Cc')),
        // Gmail exposes Bcc only on the signed-in user's own sent copy.
        bcc: parseAddressList(header(msg, 'Bcc')),
        replyTo: parseAddressList(header(msg, 'Reply-To'))
      }
      const threading = extractThreadingHeaders(msg)

      upsertMsg.run({
        account_id: accountId,
        id: msg.id,
        thread_id: thread.id,
        from_name: from.name,
        from_email: from.email,
        snippet: msg.snippet ?? '',
        internal_date: at,
        body_text: extractBodyText(msg.payload),
        body_html: extractBodyHtml(msg.payload) || null,
        recipients_json: JSON.stringify(recipients),
        attachments_json: JSON.stringify(attachments),
        labels_json: JSON.stringify(msg.labelIds ?? []),
        list_id: canonicalListId(header(msg, 'List-Id')),
        has_calendar_part: hasCalendarPart(msg.payload) ? 1 : 0,
        rfc_message_id: threading.rfcMessageId,
        references_json: JSON.stringify(threading.references),
        metadata_only: options.metadataOnly ? 1 : 0
      })

      // Contact contributions are an authoritative projection of the current
      // message snapshot. Clear first so a label transition into Spam/Trash
      // removes a previously valid sender instead of leaving stale autocomplete.
      for (const row of existingMessageContacts.all(accountId, msg.id) as { email: string }[]) {
        affectedContactEmails.add(row.email)
      }
      clearMessageContacts.run(accountId, msg.id)
      const contactEligible = !msg.labelIds?.some(
        (label) => label === 'SPAM' || label === 'TRASH' || label === 'CHAT'
      )
      if (contactEligible) {
        if (msg.labelIds?.includes('SENT')) {
          for (const recipient of [...recipients.to, ...recipients.cc, ...recipients.bcc]) {
            const email = insertContactContribution(insertContactMessage, accountId, msg.id, recipient, 'to')
            if (email) affectedContactEmails.add(email)
          }
        } else {
          const email = insertContactContribution(insertContactMessage, accountId, msg.id, from, 'from')
          if (email) affectedContactEmails.add(email)
        }
      }

      for (const label of msg.labelIds ?? []) labelUnion.add(label)
      if (!summaryMessageIds.has(msg.id)) continue
      if (!subject) subject = header(msg, 'Subject')
      if (at >= lastMsgAt) {
        lastMsgAt = at
        fromDisplay = normalizeEmailKey(from.email) === normalizeEmailKey(accountId) ? 'Me' : from.name
        snippet = msg.snippet ?? ''
      }
      anyUnread ||= unread
      anyStarred ||= msg.labelIds?.includes('STARRED') ? 1 : 0
      anyAttachment ||= attach
    }

    for (const email of removeMissingMessages(db, accountId, thread.id, incomingMessageIds)) {
      affectedContactEmails.add(email)
    }
    rebuildContacts(db, accountId, affectedContactEmails)

    upsertThread.run({
      account_id: accountId,
      id: thread.id,
      subject,
      snippet,
      last_msg_at: lastMsgAt,
      from_display: fromDisplay,
      is_unread: anyUnread,
      is_starred: anyStarred,
      has_attachment: anyAttachment,
      insert_inbox_visible: hidesNewRow ? 0 : 1,
      promote_inbox_visible: options.inboxVisibility === 'show' ? 1 : 0,
      metadata_only: options.metadataOnly ? 1 : 0
    })

    clearLabels.run(accountId, thread.id)
    for (const label of labelUnion) insertLabel.run(accountId, thread.id, label)
    // After the thread row is current: the index derives its subject from it.
    indexThreadMessages(db, accountId, thread.id)
    // After the labels are current: membership reads them and the thread flags.
    refreshThreadMailboxes(db, accountId, thread.id)
    // Inside the same transaction (better-sqlite3 nests as a savepoint): a
    // crash between the snapshot and the replay would leave the server's label
    // set visible — an archived thread back in the Inbox — until the next
    // refetch. Local intent always wins, atomically.
    replayPendingThreadDeltas(db, accountId, thread.id)
    replaySnoozeReminderDelta(db, accountId, thread.id)
  })()
  return true
}

function removeMissingMessages(
  db: Db,
  accountId: string,
  threadId: string,
  incomingMessageIds: string[]
): string[] {
  if (incomingMessageIds.length === 0) return []
  const placeholders = incomingMessageIds.map(() => '?').join(', ')
  // Driven from this thread's messages, not from the account's contact rows.
  // Written the other way round the planner scanned every `contact_messages` row
  // in the account on every thread write, so storing mail got slower the more
  // mail was already stored: importing 100,000 threads reached 17 ms each and
  // never finished. `CROSS JOIN` pins the drive to this thread's messages, since
  // the planner's own choice is what regressed here.
  const affected = db
    .prepare(
      `SELECT DISTINCT cm.email
       FROM messages m
       CROSS JOIN contact_messages cm ON cm.account_id = m.account_id AND cm.message_id = m.id
       WHERE m.account_id = ? AND m.thread_id = ? AND m.id NOT IN (${placeholders})`
    )
    .all(accountId, threadId, ...incomingMessageIds) as { email: string }[]
  db.prepare(
    `DELETE FROM contact_messages
     WHERE account_id = ? AND message_id IN (
       SELECT id FROM messages WHERE account_id = ? AND thread_id = ? AND id NOT IN (${placeholders})
     )`
  ).run(accountId, accountId, threadId, ...incomingMessageIds)
  db.prepare(
    `DELETE FROM messages WHERE account_id = ? AND thread_id = ? AND id NOT IN (${placeholders})`
  ).run(accountId, threadId, ...incomingMessageIds)
  return affected.map((row) => row.email)
}

/** Remove a thread snapshot that Gmail reports as no longer existing. */
export function deleteThread(db: Db, accountId: string, threadId: string): void {
  db.transaction(() => {
    const affected = db
      .prepare(
        `SELECT DISTINCT cm.email
         FROM contact_messages cm
         JOIN messages m ON m.account_id = cm.account_id AND m.id = cm.message_id
         WHERE m.account_id = ? AND m.thread_id = ?`
      )
      .all(accountId, threadId) as { email: string }[]
    db.prepare('DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
    db.prepare(
      `DELETE FROM contact_messages
       WHERE account_id = ? AND message_id IN (
         SELECT id FROM messages WHERE account_id = ? AND thread_id = ?
       )`
    ).run(accountId, accountId, threadId)
    removeThreadFromIndex(db, accountId, threadId)
    removeThreadMailboxes(db, accountId, threadId)
    db.prepare('DELETE FROM messages WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
    db.prepare('DELETE FROM reminders WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
    db.prepare('DELETE FROM threads WHERE account_id = ? AND id = ?').run(accountId, threadId)
    rebuildContacts(
      db,
      accountId,
      affected.map((row) => row.email)
    )
  })()
}

interface ContactStatement {
  run(...params: unknown[]): unknown
}

function insertContactContribution(
  statement: ContactStatement,
  accountId: string,
  messageId: string,
  address: { name: string; email: string },
  role: 'to' | 'from'
): string | null {
  const email = foldForSearch(address.email)
  if (!email) return null
  statement.run(accountId, messageId, email, role, address.name.trim() || null)
  return email
}

interface ContactAggregate {
  email: string
  name: string | null
  sent_to_count: number
  received_count: number
  last_interacted_at: number
}

/** Rebuild only the search rows touched by an authoritative thread snapshot. */
function rebuildContacts(db: Db, accountId: string, emails: Iterable<string>): void {
  const aggregate = db.prepare(
    `SELECT cm.email,
            (SELECT named.name
             FROM contact_messages named
             JOIN messages named_message
               ON named_message.account_id = named.account_id
              AND named_message.id = named.message_id
             WHERE named.account_id = cm.account_id AND named.email = cm.email
               AND named.name IS NOT NULL AND trim(named.name) != ''
             ORDER BY named_message.internal_date DESC, named.message_id DESC, named.role DESC
             LIMIT 1) AS name,
            SUM(CASE WHEN cm.role = 'to' THEN 1 ELSE 0 END) AS sent_to_count,
            SUM(CASE WHEN cm.role = 'from' THEN 1 ELSE 0 END) AS received_count,
            MAX(m.internal_date) AS last_interacted_at
     FROM contact_messages cm
     JOIN messages m ON m.account_id = cm.account_id AND m.id = cm.message_id
     WHERE cm.account_id = ? AND cm.email = ?
     GROUP BY cm.account_id, cm.email`
  )
  const upsert = db.prepare(
    `INSERT INTO contacts
       (account_id, email, name, name_folded, sent_to_count, received_count, last_interacted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, email) DO UPDATE SET
       name = excluded.name,
       name_folded = excluded.name_folded,
       sent_to_count = excluded.sent_to_count,
       received_count = excluded.received_count,
       last_interacted_at = excluded.last_interacted_at`
  )
  const remove = db.prepare('DELETE FROM contacts WHERE account_id = ? AND email = ?')

  for (const email of new Set(emails)) {
    const row = aggregate.get(accountId, email) as ContactAggregate | undefined
    if (!row) {
      remove.run(accountId, email)
      continue
    }
    // Fold in JS, not SQL: SQLite's lower() is ASCII-only and would leave a name
    // like "Ürsula" unmatched by the lowercase needle the query folds through the
    // same helper.
    upsert.run(
      accountId,
      row.email,
      row.name,
      row.name ? foldForSearch(row.name) : null,
      row.sent_to_count,
      row.received_count,
      row.last_interacted_at
    )
  }
}
