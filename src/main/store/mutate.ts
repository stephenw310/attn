import type { Db } from '../db'

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
     WHERE account_id = ? AND thread_id = ? AND labels_json IS NOT NULL`
  )
  const updateMessageLabels = db.prepare(
    'UPDATE messages SET labels_json = ? WHERE account_id = ? AND id = ?'
  )
  db.transaction(() => {
    for (const label of delta.remove) remove.run(accountId, delta.threadId, label)
    for (const label of delta.add) insert.run(accountId, delta.threadId, label)
    for (const row of selectMessageLabels.all(accountId, delta.threadId) as {
      id: string
      labels_json: string
    }[]) {
      const labels = new Set(JSON.parse(row.labels_json) as string[])
      for (const label of delta.remove) labels.delete(label)
      for (const label of delta.add) labels.add(label)
      const labelsJson = JSON.stringify([...labels])
      if (labelsJson !== row.labels_json) updateMessageLabels.run(labelsJson, accountId, row.id)
    }
    db.prepare(
      `UPDATE threads SET
         is_unread = EXISTS(SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'UNREAD'),
         is_starred = EXISTS(SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'STARRED')
       WHERE account_id = ? AND id = ?`
    ).run(accountId, delta.threadId, accountId, delta.threadId, accountId, delta.threadId)
  })()
}
