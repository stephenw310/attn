import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { deleteThread } from './persist'
import type { ListThreadIdsOptions, MailProvider, ThreadIdPage } from './provider'

export interface ThreadExistenceSweepOptions {
  /** Cancels the sweep before it can turn a partial listing into deletion evidence. */
  shouldContinue?: () => boolean
}

export interface ThreadExistenceSweepResult {
  listedThreadCount: number
  deletedThreadIds: string[]
}

type ExistencePhase = 'all-mail' | 'spam' | 'trash' | 'complete'

interface ExistenceStateRow {
  phase: ExistencePhase
  page_token: string | null
}

const SCOPES: Record<
  Exclude<ExistencePhase, 'complete'>,
  Pick<ListThreadIdsOptions, 'labelIds' | 'includeSpamTrash'> & { nextPhase: ExistencePhase }
> = {
  'all-mail': { nextPhase: 'spam' },
  spam: { labelIds: ['SPAM'], includeSpamTrash: true, nextPhase: 'trash' },
  trash: { labelIds: ['TRASH'], includeSpamTrash: true, nextPhase: 'complete' }
}

const MASS_DELETE_FRACTION_DENOMINATOR = 4

/**
 * Reconcile a snapshot of local thread existence against one complete Gmail
 * account listing. Page evidence and its cursor commit together, so a later
 * retry resumes without treating a partial listing as deletion evidence.
 */
export async function reconcileThreadExistence(
  db: Db,
  accountId: string,
  provider: MailProvider,
  options: ThreadExistenceSweepOptions = {}
): Promise<ThreadExistenceSweepResult | null> {
  const shouldContinue = options.shouldContinue ?? (() => true)
  initializeSweep(db, accountId)
  let resetExpiredCursor = false

  for (;;) {
    if (!shouldContinue()) return null
    const state = readState(db, accountId)
    if (!state) throw new Error(`missing thread existence state for ${accountId}`)
    if (state.phase === 'complete') break
    const { nextPhase, ...scope } = SCOPES[state.phase]

    let page: ThreadIdPage
    try {
      page = await provider.listThreadIds({
        ...scope,
        pageToken: state.page_token ?? undefined,
        priority: 'background'
      })
    } catch (error) {
      if (!state.page_token || resetExpiredCursor || !isExpiredPageToken(error)) throw error
      restartListing(db, accountId)
      resetExpiredCursor = true
      continue
    }
    if (!shouldContinue()) return null
    persistPage(
      db,
      accountId,
      state.phase,
      page.threadIds,
      page.nextPageToken ? state.phase : nextPhase,
      page.nextPageToken
    )
  }

  if (!shouldContinue()) return null
  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(was_local), 0) AS local_count,
         COALESCE(SUM(remote_seen), 0) AS remote_count
       FROM thread_existence_evidence
       WHERE account_id = ?`
    )
    .get(accountId) as { local_count: number; remote_count: number }
  const missing = listMissingSnapshotThreads(db, accountId)
  if (missing.length > 0 && missing.length * MASS_DELETE_FRACTION_DENOMINATOR >= counts.local_count) {
    if (!(await verifyMassDeletion(db, accountId, provider, missing, shouldContinue))) return null
  }

  // No await occurs between the final guard and the deletes. A session change
  // cannot turn old evidence into a half-applied pass, and a crash mid-delete
  // resumes from the durable complete state.
  if (!shouldContinue()) return null
  const deletedThreadIds = listMissingSnapshotThreads(db, accountId).map((row) => row.id)
  for (const threadId of deletedThreadIds) deleteThread(db, accountId, threadId)
  clearSweep(db, accountId)
  return { listedThreadCount: counts.remote_count, deletedThreadIds }
}

function initializeSweep(db: Db, accountId: string): void {
  db.transaction(() => {
    if (readState(db, accountId)) return
    db.prepare('DELETE FROM thread_existence_evidence WHERE account_id = ?').run(accountId)
    db.prepare(
      `INSERT INTO thread_existence_evidence
         (account_id, thread_id, was_local, remote_seen, verified_missing)
       SELECT account_id, id, 1, 0, 0
       FROM threads
       WHERE account_id = ?`
    ).run(accountId)
    db.prepare(
      `INSERT INTO thread_existence_state (account_id, phase, page_token)
       VALUES (?, 'all-mail', NULL)`
    ).run(accountId)
  })()
}

function readState(db: Db, accountId: string): ExistenceStateRow | undefined {
  return db
    .prepare('SELECT phase, page_token FROM thread_existence_state WHERE account_id = ?')
    .get(accountId) as ExistenceStateRow | undefined
}

function persistPage(
  db: Db,
  accountId: string,
  expectedPhase: Exclude<ExistencePhase, 'complete'>,
  threadIds: string[],
  nextPhase: ExistencePhase,
  nextPageToken: string | undefined
): void {
  const insert = db.prepare(
    `INSERT INTO thread_existence_evidence
       (account_id, thread_id, was_local, remote_seen, verified_missing)
     VALUES (?, ?, 0, 1, 0)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET
       remote_seen = 1,
       verified_missing = 0`
  )
  const checkpoint = db.prepare(
    `UPDATE thread_existence_state
     SET phase = ?, page_token = ?
     WHERE account_id = ? AND phase = ?`
  )
  db.transaction(() => {
    for (const threadId of threadIds) insert.run(accountId, threadId)
    const changed = checkpoint.run(nextPhase, nextPageToken ?? null, accountId, expectedPhase).changes
    if (changed !== 1) throw new Error(`thread existence phase changed during ${expectedPhase}`)
  })()
}

function restartListing(db: Db, accountId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM thread_existence_evidence WHERE account_id = ? AND was_local = 0').run(accountId)
    db.prepare(
      `UPDATE thread_existence_evidence
       SET remote_seen = 0, verified_missing = 0
       WHERE account_id = ?`
    ).run(accountId)
    db.prepare(
      `UPDATE thread_existence_state
       SET phase = 'all-mail', page_token = NULL
       WHERE account_id = ?`
    ).run(accountId)
  })()
}

function listMissingSnapshotThreads(db: Db, accountId: string): { id: string }[] {
  return db
    .prepare(
      `SELECT evidence.thread_id AS id
       FROM thread_existence_evidence evidence
       JOIN threads local
         ON local.account_id = evidence.account_id AND local.id = evidence.thread_id
       WHERE evidence.account_id = ?
         AND evidence.was_local = 1
         AND evidence.remote_seen = 0
       ORDER BY evidence.thread_id`
    )
    .all(accountId) as { id: string }[]
}

async function verifyMassDeletion(
  db: Db,
  accountId: string,
  provider: MailProvider,
  candidates: { id: string }[],
  shouldContinue: () => boolean
): Promise<boolean> {
  const verified = db.prepare(
    `SELECT verified_missing
     FROM thread_existence_evidence
     WHERE account_id = ? AND thread_id = ?`
  )
  const markVerified = db.prepare(
    `UPDATE thread_existence_evidence SET verified_missing = 1
     WHERE account_id = ? AND thread_id = ?`
  )
  for (const { id } of candidates) {
    const row = verified.get(accountId, id) as { verified_missing: number } | undefined
    if (row?.verified_missing) continue
    if (!shouldContinue()) return false
    try {
      await provider.getThread(id, { format: 'metadata', priority: 'background' })
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        markVerified.run(accountId, id)
        continue
      }
      throw error
    }
    if (!shouldContinue()) return false
    clearSweep(db, accountId)
    throw new Error(`account existence listing omitted live thread ${id}; retrying without deletion`)
  }
  return true
}

function clearSweep(db: Db, accountId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM thread_existence_evidence WHERE account_id = ?').run(accountId)
    db.prepare('DELETE FROM thread_existence_state WHERE account_id = ?').run(accountId)
  })()
}

function isExpiredPageToken(error: unknown): boolean {
  return error instanceof GmailApiError && (error.status === 400 || error.status === 404)
}
