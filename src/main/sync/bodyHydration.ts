import type { Db } from '../db'

export interface StoredMessageBody {
  bodyText: string | null | undefined
  bodyHtml: string | null | undefined
}

/** Metadata-only rows have neither a stored plain-text body nor stored HTML. */
export function needsBodyHydration(body: StoredMessageBody): boolean {
  return !body.bodyText?.trim() && !body.bodyHtml?.trim()
}

/** Snapshot the metadata-only messages in a thread before and after an on-demand fetch. */
export function missingBodyMessageIds(db: Db, accountId: string, threadId: string): Set<string> {
  const rows = db
    .prepare('SELECT id, body_text, body_html FROM messages WHERE account_id = ? AND thread_id = ?')
    .all(accountId, threadId) as { id: string; body_text: string | null; body_html: string | null }[]
  return new Set(
    rows
      .filter((row) => needsBodyHydration({ bodyText: row.body_text, bodyHtml: row.body_html }))
      .map((row) => row.id)
  )
}
