// Read queries for the renderer. Plain Node module (no Electron imports).

import type { Db } from './index'
import type { Conversation, ConversationMsg, ThreadRow } from '../../shared/mail'

export function firstAccountId(db: Db): string | null {
  const row = db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string } | undefined
  return row?.id ?? null
}

export function listInboxThreads(db: Db, accountId: string, limit = 300): ThreadRow[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.from_display, t.subject, t.snippet, t.last_msg_at,
              t.is_unread, t.is_starred, t.has_attachment
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
  }[]

  return rows.map((r) => ({
    id: r.id,
    fromDisplay: r.from_display ?? '',
    subject: r.subject ?? '(no subject)',
    snippet: r.snippet ?? '',
    lastMsgAt: r.last_msg_at ?? 0,
    unread: r.is_unread === 1,
    starred: r.is_starred === 1,
    hasAttachment: r.has_attachment === 1
  }))
}

export function getConversation(db: Db, accountId: string, threadId: string): Conversation | null {
  const thread = db
    .prepare('SELECT subject FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, threadId) as { subject: string | null } | undefined
  if (!thread) return null

  const rows = db
    .prepare(
      `SELECT id, from_name, from_email, to_json, internal_date, body_text, snippet
       FROM messages WHERE account_id = ? AND thread_id = ?
       ORDER BY internal_date ASC`
    )
    .all(accountId, threadId) as {
    id: string
    from_name: string | null
    from_email: string | null
    to_json: string | null
    internal_date: number | null
    body_text: string | null
    snippet: string | null
  }[]

  const messages: ConversationMsg[] = rows.map((r) => ({
    id: r.id,
    fromName: r.from_name ?? '',
    fromEmail: r.from_email ?? '',
    to: parseTo(r.to_json),
    at: r.internal_date ?? 0,
    bodyText: r.body_text || r.snippet || ''
  }))

  return { threadId, subject: thread.subject ?? '(no subject)', messages }
}

function parseTo(toJson: string | null): string {
  try {
    const arr = JSON.parse(toJson ?? '[]') as string[]
    return arr[0] ?? ''
  } catch {
    return ''
  }
}
