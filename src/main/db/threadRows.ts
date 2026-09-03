// The one list-row projection. Every thread list — the system mailboxes, user
// labels, the Inbox and its returned-follow-up tier, and search — selects the
// same auxiliary columns and maps them the same way; five copies of the mapper
// had already drifted (search never set `followUpReturned`, so its results
// could not show the Follow up chip the other lists show).

import type { ThreadRow } from '../../shared/mail'

/** Reminder, draft and label columns every thread list projects beside the thread row. */
export const THREAD_AUXILIARY_PROJECTION_SQL = `EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'snooze' AND r.state = 'pending') AS snoozed,
              EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'snooze' AND r.state = 'returned') AS returned,
              EXISTS(SELECT 1 FROM reminders r
                     WHERE r.account_id = t.account_id AND r.thread_id = t.id
                       AND r.kind = 'follow_up' AND r.state = 'returned') AS follow_up_returned,
              EXISTS(SELECT 1 FROM outbox o
                     WHERE o.account_id = t.account_id AND o.thread_id = t.id
                       AND o.state IN ('composing', 'drafted')) AS has_draft`

/**
 * The thread's label set as one unit-separated column. Runs over the projected
 * rows rather than inside the paging query, so it visits one page of threads.
 */
export function labelIdsProjectionSql(alias: string): string {
  return `COALESCE((SELECT GROUP_CONCAT(tl.label_id, char(31))
                      FROM thread_labels tl
                      WHERE tl.account_id = ${alias}.account_id AND tl.thread_id = ${alias}.id), '')
              AS label_ids`
}

export function labelIds(value: string): string[] {
  return value ? value.split('\u001f') : []
}

/** Columns `THREAD_AUXILIARY_PROJECTION_SQL` and the thread projection produce. */
export interface ThreadProjectionRow {
  id: string
  from_display: string | null
  subject: string | null
  snippet: string | null
  is_unread: number
  is_starred: number
  has_attachment: number
  snoozed: number
  returned: number
  follow_up_returned: number
  has_draft: number
  label_ids: string
}

/** Map one projected row; the sort timestamp is named differently per view. */
export function toThreadRow(row: ThreadProjectionRow, lastMsgAt: number | null): ThreadRow {
  return {
    id: row.id,
    fromDisplay: row.from_display ?? '',
    subject: row.subject ?? '(no subject)',
    snippet: row.snippet ?? '',
    lastMsgAt: lastMsgAt ?? 0,
    unread: row.is_unread === 1,
    starred: row.is_starred === 1,
    hasAttachment: row.has_attachment === 1,
    snoozed: row.snoozed === 1,
    returned: row.returned === 1,
    followUpReturned: row.follow_up_returned === 1,
    hasDraft: row.has_draft === 1,
    labelIds: labelIds(row.label_ids)
  }
}
