import { expect, it } from 'vitest'
import { type Db, openDatabase } from '.'
import { listMailboxThreads } from './queries'

it('pages body-heavy Spam without sorting message bodies', () => {
  const db = openDatabase(':memory:')
  try {
    db.prepare("INSERT INTO accounts (id, email) VALUES ('perf', 'perf@test')").run()
    const thread = db.prepare("INSERT INTO threads (account_id,id,last_msg_at) VALUES ('perf',?,?)")
    const label = db.prepare(
      "INSERT INTO thread_labels (account_id,thread_id,label_id) VALUES ('perf',?,'SPAM')"
    )
    const message = db.prepare(
      "INSERT INTO messages (account_id,id,thread_id,internal_date,labels_json,body_html) VALUES ('perf',?,?,?,'[\"SPAM\"]',?)"
    )
    const body = '<p>Mail body</p>'.repeat(8192)
    db.transaction(() => {
      for (let index = 0; index < 1000; index++) {
        const id = `spam-${index}`
        thread.run(id, index)
        label.run(id)
        message.run(id, id, index, body)
      }
    })()
    const rootPage = (
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'messages'").get() as { rootpage: number }
    ).rootpage
    const bodyColumns = (db.prepare('PRAGMA table_info(messages)').all() as { cid: number; name: string }[])
      .filter((column) => column.name === 'body_html' || column.name === 'body_text')
      .map((column) => column.cid)
    let bodyReads: unknown[] = []
    const checkedDb = {
      prepare: (sql: string) => ({
        all: (...args: unknown[]) => {
          // Inspect SQLite's executed column reads, not SQL spelling or a
          // wall-clock limit that depends on CI hardware.
          const program = db.prepare(`EXPLAIN ${sql}`).all(...args) as {
            opcode: string
            p1: number
            p2: number
          }[]
          const messageCursors = program
            .filter((op) => op.opcode === 'OpenRead' && op.p2 === rootPage)
            .map((op) => op.p1)
          expect(messageCursors.length).toBeGreaterThan(0)
          bodyReads = program.filter(
            (op) => op.opcode === 'Column' && messageCursors.includes(op.p1) && bodyColumns.includes(op.p2)
          )
          return db.prepare(sql).all(...args)
        }
      })
    } as unknown as Db
    const started = performance.now()
    const rows = listMailboxThreads(checkedDb, 'perf', 'spam', 100)
    const elapsed = performance.now() - started
    console.log(`Spam first page, 1000 body-heavy messages: ${elapsed.toFixed(1)} ms`)
    expect(bodyReads).toEqual([])
    expect(rows).toHaveLength(100)
    expect(rows[0].id).toBe('spam-999')
  } finally {
    db.close()
  }
})
