import { NOTIFICATION_SUMMARY_THRESHOLD } from '../../shared/notifications'
import type { Db } from '../db'
import { deleteSetting, readSetting, writeSetting } from '../settings'
import { notificationEnabledSplitIds, splitAssignmentForAccount } from '../splits'
import type { NewMail } from '../sync/poller'

const PAUSED_UNTIL_KEY = 'notificationsPausedUntil'

export interface NotificationCandidate extends NewMail {
  sender: string
  subject: string
  snippet: string
}

export function notificationPausedUntil(db: Db): number | null {
  const stored = readSetting(db, PAUSED_UNTIL_KEY)
  if (stored === undefined) return null
  const value = Number(stored)
  return Number.isFinite(value) ? value : null
}

export function setNotificationPausedUntil(db: Db, pausedUntil: number | null): void {
  if (pausedUntil === null) {
    deleteSetting(db, PAUSED_UNTIL_KEY)
    return
  }
  writeSetting(db, PAUSED_UNTIL_KEY, String(pausedUntil))
}

export function candidatesFor(
  db: Db,
  accountId: string,
  newMail: readonly NewMail[]
): NotificationCandidate[] {
  const distinct = new Map<string, NewMail>()
  for (const mail of newMail) distinct.set(mail.threadId, mail)
  if (distinct.size === 0) return []
  const enabledSplitIds = notificationEnabledSplitIds(db, accountId)
  if (enabledSplitIds.length === 0) return []
  const assignment = splitAssignmentForAccount(db, accountId)
  const placeholders = [...distinct].map(() => '?').join(', ')
  const enabledPlaceholders = enabledSplitIds.map(() => '?').join(', ')
  const inboxRows = db
    .prepare(
      `SELECT m.id AS message_id, m.thread_id AS thread_id
         FROM messages m
         JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
         WHERE m.account_id = ? AND m.id IN (${placeholders})
           AND t.is_inbox_visible = 1
           AND EXISTS (SELECT 1 FROM thread_labels tl
                       WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id
                         AND tl.label_id = 'INBOX')
           AND (${assignment.sql}) IN (${enabledPlaceholders})`
    )
    .all(
      accountId,
      ...[...distinct.values()].map((mail) => mail.messageId),
      ...assignment.params,
      ...enabledSplitIds
    ) as {
    message_id: string
    thread_id: string
  }[]
  const eligible = new Set(inboxRows.map((row) => `${row.thread_id}\u0000${row.message_id}`))
  const inboxMail = [...distinct.values()].filter((mail) =>
    eligible.has(`${mail.threadId}\u0000${mail.messageId}`)
  )
  if (inboxMail.length > NOTIFICATION_SUMMARY_THRESHOLD) {
    return inboxMail.map((mail) => ({ ...mail, sender: '', subject: '', snippet: '' }))
  }

  const candidates: NotificationCandidate[] = []
  const statement = db.prepare(
    `SELECT m.from_name, m.from_email, m.snippet, t.subject
         FROM messages m
         JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
         WHERE m.account_id = ? AND m.id = ? AND m.thread_id = ?`
  )
  for (const mail of inboxMail) {
    const row = statement.get(accountId, mail.messageId, mail.threadId) as
      | {
          from_name: string | null
          from_email: string | null
          snippet: string | null
          subject: string | null
        }
      | undefined
    if (!row) continue
    candidates.push({
      ...mail,
      sender: row.from_name || row.from_email || '',
      subject: row.subject || '(no subject)',
      snippet: row.snippet || ''
    })
  }
  return candidates
}
