import { messageLabelsMatchMailbox } from '../../shared/mail'
import type { Db } from '../db'
import { refreshThreadMailboxes } from '../db/mailboxMembership'

export interface ThreadDelta {
  threadId: string
  add: string[]
  remove: string[]
}

export function applyThreadDelta(db: Db, accountId: string, delta: ThreadDelta): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)'
  )
  const remove = db.prepare(
    'DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = ?'
  )
  const selectMessageLabels = db.prepare(
    `SELECT id, labels_json FROM messages
     WHERE account_id = ? AND thread_id = ?`
  )
  const updateMessageLabels = db.prepare(
    'UPDATE messages SET labels_json = ? WHERE account_id = ? AND id = ?'
  )
  db.transaction(() => {
    for (const label of delta.remove) remove.run(accountId, delta.threadId, label)
    for (const label of delta.add) insert.run(accountId, delta.threadId, label)
    const knownMessageLabels: Set<string>[] = []
    let hasLegacyMessageLabels = false
    for (const row of selectMessageLabels.all(accountId, delta.threadId) as {
      id: string
      labels_json: string | null
    }[]) {
      if (row.labels_json === null) {
        hasLegacyMessageLabels = true
        continue
      }
      const labels = new Set(JSON.parse(row.labels_json) as string[])
      for (const label of delta.remove) labels.delete(label)
      for (const label of delta.add) labels.add(label)
      const labelsJson = JSON.stringify([...labels])
      if (labelsJson !== row.labels_json) updateMessageLabels.run(labelsJson, accountId, row.id)
      knownMessageLabels.push(labels)
    }

    const summaryLabels = knownMessageLabels.filter((labels) => messageLabelsMatchMailbox(labels, 'normal'))
    const labelsForFlags = summaryLabels.length > 0 ? summaryLabels : knownMessageLabels
    const threadLabels = hasLegacyMessageLabels
      ? new Set(
          (
            db
              .prepare('SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ?')
              .all(accountId, delta.threadId) as { label_id: string }[]
          ).map((row) => row.label_id)
        )
      : null
    const unread = threadLabels
      ? threadLabels.has('UNREAD')
      : labelsForFlags.some((labels) => labels.has('UNREAD'))
    const starred = threadLabels
      ? threadLabels.has('STARRED')
      : labelsForFlags.some((labels) => labels.has('STARRED'))
    db.prepare('UPDATE threads SET is_unread = ?, is_starred = ? WHERE account_id = ? AND id = ?').run(
      unread ? 1 : 0,
      starred ? 1 : 0,
      accountId,
      delta.threadId
    )
    // An optimistic label change moves the thread between mailboxes, so derived
    // membership converges inside the same transaction as the labels.
    refreshThreadMailboxes(db, accountId, delta.threadId)
  })()
}
