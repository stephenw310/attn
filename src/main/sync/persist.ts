import type { Db } from '../db'
import {
  collectAttachments,
  extractBodyHtml,
  extractBodyText,
  extractThreadingHeaders,
  type GmailThread,
  header,
  parseAddress,
  parseAddressList
} from '../gmail/parse'
import { replayPendingThreadDeltas } from '../store/replay'

export interface LabelRow {
  id: string
  name: string
  type: string
}

/** Idempotently register an account row (account id doubles as the email in v1). */
export function ensureAccount(db: Db, accountId: string, email: string): void {
  db.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
    accountId,
    email,
    Date.now()
  )
}

/** Upsert label rows — the one statement both backfill and seeding go through. */
export function upsertLabels(db: Db, accountId: string, labels: LabelRow[]): void {
  const upsert = db.prepare(
    `INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type`
  )
  for (const label of labels) upsert.run(accountId, label.id, label.name, label.type)
}

export interface PersistThreadOptions {
  metadataOnly?: boolean
}

/** Persist an authoritative Gmail thread snapshot through the production write path. */
export function persistThread(
  db: Db,
  accountId: string,
  thread: GmailThread,
  options: PersistThreadOptions = {}
): void {
  const messages = thread.messages ?? []
  if (messages.length === 0) return

  const upsertMsg = db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, to_json, subject, snippet,
                           internal_date, is_unread, body_text, body_html, recipients_json,
                           attachments_json, rfc_message_id, references_json)
     VALUES (@account_id, @id, @thread_id, @from_name, @from_email, @to_json, @subject, @snippet,
             @internal_date, @is_unread, @body_text, @body_html, @recipients_json,
             @attachments_json, @rfc_message_id, @references_json)
     ON CONFLICT(account_id, id) DO UPDATE SET
       is_unread = excluded.is_unread, snippet = excluded.snippet,
       body_text = CASE WHEN messages.body_text IS NULL OR messages.body_text = ''
                        THEN excluded.body_text ELSE messages.body_text END,
       body_html = CASE WHEN messages.body_html IS NULL OR messages.body_html = ''
                        THEN excluded.body_html ELSE messages.body_html END,
       recipients_json = excluded.recipients_json,
       attachments_json = CASE WHEN @metadata_only = 1
                               THEN messages.attachments_json ELSE excluded.attachments_json END,
       rfc_message_id = excluded.rfc_message_id,
       references_json = excluded.references_json`
  )
  const upsertThread = db.prepare(
    `INSERT INTO threads (account_id, id, history_id, subject, snippet, last_msg_at,
                          from_display, is_unread, is_starred, has_attachment)
     VALUES (@account_id, @id, @history_id, @subject, @snippet, @last_msg_at,
             @from_display, @is_unread, @is_starred, @has_attachment)
     ON CONFLICT(account_id, id) DO UPDATE SET
       history_id = excluded.history_id, subject = excluded.subject, snippet = excluded.snippet,
       last_msg_at = excluded.last_msg_at, from_display = excluded.from_display,
       is_unread = excluded.is_unread, is_starred = excluded.is_starred,
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
  const incomingMessageIds = messages.map((message) => message.id)

  db.transaction(() => {
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
      const attach = attachments.length > 0 ? 1 : 0
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
        to_json: JSON.stringify([header(msg, 'To')]),
        subject: header(msg, 'Subject'),
        snippet: msg.snippet ?? '',
        internal_date: at,
        is_unread: unread,
        body_text: extractBodyText(msg.payload),
        body_html: extractBodyHtml(msg.payload) || null,
        recipients_json: JSON.stringify(recipients),
        attachments_json: JSON.stringify(attachments),
        rfc_message_id: threading.rfcMessageId,
        references_json: JSON.stringify(threading.references),
        metadata_only: options.metadataOnly ? 1 : 0
      })

      if (msg.labelIds?.includes('SENT')) {
        for (const recipient of [...recipients.to, ...recipients.cc, ...recipients.bcc]) {
          insertContactContribution(insertContactMessage, accountId, msg.id, recipient, 'to')
        }
      } else {
        insertContactContribution(insertContactMessage, accountId, msg.id, from, 'from')
      }

      for (const label of msg.labelIds ?? []) labelUnion.add(label)
      if (!subject) subject = header(msg, 'Subject')
      if (at >= lastMsgAt) {
        lastMsgAt = at
        fromDisplay = from.name
        snippet = msg.snippet ?? ''
      }
      anyUnread ||= unread
      anyStarred ||= msg.labelIds?.includes('STARRED') ? 1 : 0
      anyAttachment ||= attach
    }

    pruneMissingMessages(db, accountId, thread.id, incomingMessageIds)

    upsertThread.run({
      account_id: accountId,
      id: thread.id,
      history_id: thread.historyId ?? null,
      subject,
      snippet,
      last_msg_at: lastMsgAt,
      from_display: fromDisplay,
      is_unread: anyUnread,
      is_starred: anyStarred,
      has_attachment: anyAttachment,
      metadata_only: options.metadataOnly ? 1 : 0
    })

    clearLabels.run(accountId, thread.id)
    for (const label of labelUnion) insertLabel.run(accountId, thread.id, label)
  })()
  replayPendingThreadDeltas(db, accountId, thread.id)
}

/** A thread snapshot is authoritative for which messages still exist in it. */
export function pruneMissingMessages(
  db: Db,
  accountId: string,
  threadId: string,
  incomingMessageIds: string[]
): void {
  if (incomingMessageIds.length === 0) return
  const placeholders = incomingMessageIds.map(() => '?').join(', ')
  db.prepare(
    `DELETE FROM contact_messages
     WHERE account_id = ? AND message_id IN (
       SELECT id FROM messages WHERE account_id = ? AND thread_id = ? AND id NOT IN (${placeholders})
     )`
  ).run(accountId, accountId, threadId, ...incomingMessageIds)
  db.prepare(
    `DELETE FROM messages WHERE account_id = ? AND thread_id = ? AND id NOT IN (${placeholders})`
  ).run(accountId, threadId, ...incomingMessageIds)
}

/** Remove a thread snapshot that Gmail reports as no longer existing. */
export function deleteThread(db: Db, accountId: string, threadId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
    db.prepare(
      `DELETE FROM contact_messages
       WHERE account_id = ? AND message_id IN (
         SELECT id FROM messages WHERE account_id = ? AND thread_id = ?
       )`
    ).run(accountId, accountId, threadId)
    db.prepare('DELETE FROM messages WHERE account_id = ? AND thread_id = ?').run(accountId, threadId)
    db.prepare('DELETE FROM threads WHERE account_id = ? AND id = ?').run(accountId, threadId)
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
): void {
  const email = address.email.trim().toLocaleLowerCase()
  if (!email) return
  statement.run(accountId, messageId, email, role, address.name.trim() || null)
}
