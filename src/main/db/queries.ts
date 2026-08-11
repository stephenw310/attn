// Read queries for the renderer. Plain Node module (no Electron imports).

import type {
  Conversation,
  ConversationMsg,
  MailLabel,
  MessageAttachment,
  MessageRecipients,
  SnoozedThreadRow,
  ThreadRow
} from '../../shared/mail'
import type { Db } from './index'

interface StoredAttachment extends MessageAttachment {
  inlineData?: string
}

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

export function listInboxThreads(db: Db, accountId: string, limit = 300): ThreadRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
              t.is_unread, t.is_starred, t.has_attachment,
              EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'snooze' AND r.state = 'returned') AS returned
       FROM threads t
       WHERE t.account_id = ?
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
    labelIds: labelIds.get(r.id) ?? []
  }))
}

export function listSnoozedThreads(db: Db, accountId: string, limit = 300): SnoozedThreadRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
              t.is_unread, t.is_starred, t.has_attachment, r.due_at
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
         AND t.is_unread = 1
         AND EXISTS (SELECT 1 FROM thread_labels tl
                     WHERE tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = 'INBOX')`
    )
    .get(accountId) as { count: number }

  return row.count
}

export function getConversation(db: Db, accountId: string, threadId: string): Conversation | null {
  const thread = db
    .prepare('SELECT subject FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, threadId) as { subject: string | null } | undefined
  if (!thread) return null

  const rows = db
    .prepare(
      `SELECT id, from_name, from_email, internal_date, body_text, body_html, recipients_json,
              attachments_json, snippet
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
  }[]

  const messages: ConversationMsg[] = rows.map((r) => ({
    id: r.id,
    fromName: r.from_name ?? '',
    fromEmail: r.from_email ?? '',
    at: r.internal_date ?? 0,
    recipients: parseJson(r.recipients_json, EMPTY_RECIPIENTS),
    attachments: parseJson<StoredAttachment[]>(r.attachments_json, []).map(
      ({ inlineData: _inlineData, ...attachment }) => attachment
    ),
    bodyText: r.body_text || r.snippet || '',
    bodyHtml: r.body_html
  }))

  return { threadId, subject: thread.subject ?? '(no subject)', messages }
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
  try {
    return JSON.parse(value ?? '') as T
  } catch {
    return fallback
  }
}
