import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db'
import { applyThreadDelta } from './mutate'

describe('thread label deltas', () => {
  it('updates known per-message labels and leaves legacy unknown labels for refetch', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(
        `INSERT INTO threads (account_id, id, subject, last_msg_at)
         VALUES ('account', 'thread', 'Roadmap', 100)`
      ).run()
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES ('account', 'thread', 'INBOX')`
      ).run()
      const insert = db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES ('account', ?, 'thread', ?)`
      )
      insert.run('known', '["INBOX","UNREAD"]')
      insert.run('legacy', null)

      applyThreadDelta(db, 'account', {
        threadId: 'thread',
        add: ['TRASH'],
        remove: ['INBOX', 'UNREAD']
      })

      expect(
        db.prepare('SELECT labels_json FROM messages WHERE account_id = ? AND id = ?').get('account', 'known')
      ).toEqual({ labels_json: '["TRASH"]' })
      expect(
        db
          .prepare('SELECT labels_json FROM messages WHERE account_id = ? AND id = ?')
          .get('account', 'legacy')
      ).toEqual({ labels_json: null })
      expect(
        db
          .prepare(
            'SELECT label_id FROM thread_labels WHERE account_id = ? AND thread_id = ? ORDER BY label_id'
          )
          .all('account', 'thread')
      ).toEqual([{ label_id: 'TRASH' }])
    } finally {
      db.close()
    }
  })

  it('keeps hidden junk labels out of optimistic normal-reader flags', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(
        `INSERT INTO threads (account_id, id, subject, last_msg_at)
         VALUES ('account', 'thread', 'Roadmap', 100)`
      ).run()
      const insertLabel = db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES ('account', 'thread', ?)`
      )
      for (const label of ['INBOX', 'TRASH', 'UNREAD']) insertLabel.run(label)
      const insertMessage = db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES ('account', ?, 'thread', ?)`
      )
      insertMessage.run('visible', '["INBOX"]')
      insertMessage.run('trashed', '["TRASH","UNREAD"]')

      applyThreadDelta(db, 'account', {
        threadId: 'thread',
        add: ['Label_1'],
        remove: []
      })

      expect(
        db
          .prepare('SELECT is_unread, is_starred FROM threads WHERE account_id = ? AND id = ?')
          .get('account', 'thread')
      ).toEqual({ is_unread: 0, is_starred: 0 })
    } finally {
      db.close()
    }
  })
})
