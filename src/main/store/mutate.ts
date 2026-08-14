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
  db.transaction(() => {
    for (const label of delta.remove) remove.run(accountId, delta.threadId, label)
    for (const label of delta.add) insert.run(accountId, delta.threadId, label)
    db.prepare(
      `UPDATE threads SET
         is_unread = EXISTS(SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'UNREAD'),
         is_starred = EXISTS(SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'STARRED')
       WHERE account_id = ? AND id = ?`
    ).run(accountId, delta.threadId, accountId, delta.threadId, accountId, delta.threadId)
  })()
}
