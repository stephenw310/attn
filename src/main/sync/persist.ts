import type { Db } from '../db'
import {
  collectAttachments,
  extractBodyHtml,
  extractBodyText,
  type GmailThread,
  hasAttachment,
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

/** Persist a fully fetched Gmail thread through the production sync write path. */
export function persistThread(db: Db, accountId: string, thread: GmailThread): void {
  const messages = thread.messages ?? []
  if (messages.length === 0) return

  const upsertMsg = db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, to_json, subject, snippet,
                           internal_date, is_unread, body_text, body_html, recipients_json,
                           attachments_json)
     VALUES (@account_id, @id, @thread_id, @from_name, @from_email, @to_json, @subject, @snippet,
             @internal_date, @is_unread, @body_text, @body_html, @recipients_json,
             @attachments_json)
     ON CONFLICT(account_id, id) DO UPDATE SET
       is_unread = excluded.is_unread, snippet = excluded.snippet,
       body_text = CASE WHEN messages.body_text IS NULL OR messages.body_text = ''
                        THEN excluded.body_text ELSE messages.body_text END,
       body_html = CASE WHEN messages.body_html IS NULL OR messages.body_html = ''
                        THEN excluded.body_html ELSE messages.body_html END,
       recipients_json = excluded.recipients_json,
       attachments_json = excluded.attachments_json`
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
       has_attachment = excluded.has_attachment`
  )
  const clearLabels = db.prepare('DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?')
  const insertLabel = db.prepare(
    'INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
  )

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
      const attach = hasAttachment(msg.payload) ? 1 : 0

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
        recipients_json: JSON.stringify({
          to: parseAddressList(header(msg, 'To')),
          cc: parseAddressList(header(msg, 'Cc')),
          // Gmail exposes Bcc only on the signed-in user's own sent copy.
          bcc: parseAddressList(header(msg, 'Bcc')),
          replyTo: parseAddressList(header(msg, 'Reply-To'))
        }),
        attachments_json: JSON.stringify(collectAttachments(msg.payload))
      })

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
      has_attachment: anyAttachment
    })

    clearLabels.run(accountId, thread.id)
    for (const label of labelUnion) insertLabel.run(accountId, thread.id, label)
  })()
  replayPendingThreadDeltas(db, accountId, thread.id)
}
