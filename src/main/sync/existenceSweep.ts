import type { Db } from '../db'
import { deleteThread } from './persist'
import type { ListThreadIdsOptions, MailProvider } from './provider'

export interface ThreadExistenceSweepOptions {
  /** Cancels the sweep before it can turn a partial listing into deletion evidence. */
  shouldContinue?: () => boolean
}

export interface ThreadExistenceSweepResult {
  listedThreadCount: number
  deletedThreadIds: string[]
}

let nextTemporaryTableId = 0

/**
 * Reconcile local thread existence against one complete Gmail account listing.
 * Gmail's default listing excludes Spam and Trash, so all three scopes must
 * finish before absence proves that a local thread was deleted server-side.
 */
export async function reconcileThreadExistence(
  db: Db,
  accountId: string,
  provider: MailProvider,
  options: ThreadExistenceSweepOptions = {}
): Promise<ThreadExistenceSweepResult | null> {
  const shouldContinue = options.shouldContinue ?? (() => true)
  const tableName = `thread_existence_${++nextTemporaryTableId}`
  db.exec(`CREATE TEMP TABLE ${tableName} (thread_id TEXT PRIMARY KEY) WITHOUT ROWID`)
  const insert = db.prepare(`INSERT OR IGNORE INTO ${tableName} (thread_id) VALUES (?)`)

  try {
    for (const scope of [
      {},
      { labelIds: ['SPAM'], includeSpamTrash: true },
      { labelIds: ['TRASH'], includeSpamTrash: true }
    ] satisfies Array<Pick<ListThreadIdsOptions, 'labelIds' | 'includeSpamTrash'>>) {
      if (!(await collectScope(provider, scope, insert, shouldContinue))) return null
    }
    if (!shouldContinue()) return null

    const missing = db
      .prepare(
        `SELECT local.id
         FROM threads local
         WHERE local.account_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${tableName} remote WHERE remote.thread_id = local.id
           )
         ORDER BY local.id`
      )
      .all(accountId) as { id: string }[]

    // No await occurs between the final guard and the deletes, so a session
    // change cannot turn a partial or stale listing into a half-applied pass.
    if (!shouldContinue()) return null
    const deletedThreadIds = missing.map((row) => row.id)
    for (const threadId of deletedThreadIds) deleteThread(db, accountId, threadId)

    const listedThreadCount = (
      db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }
    ).count
    return { listedThreadCount, deletedThreadIds }
  } finally {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`)
  }
}

interface ThreadIdInsert {
  run(threadId: string): unknown
}

async function collectScope(
  provider: MailProvider,
  scope: Pick<ListThreadIdsOptions, 'labelIds' | 'includeSpamTrash'>,
  insert: ThreadIdInsert,
  shouldContinue: () => boolean
): Promise<boolean> {
  let pageToken: string | undefined
  do {
    if (!shouldContinue()) return false
    const page = await provider.listThreadIds({ ...scope, pageToken, priority: 'background' })
    if (!shouldContinue()) return false
    for (const threadId of page.threadIds) insert.run(threadId)
    pageToken = page.nextPageToken
  } while (pageToken)
  return true
}
