// Resumable 12-month INBOX backfill. Each completed page checkpoints its next
// token, so a killed app safely repeats at most the page that was in flight.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { ensureAccount, persistThread, upsertLabels } from './persist'
import type { MailProvider } from './provider'

export interface BackfillCallbacks {
  onProgress: (threadsDone: number) => void
  onDone: (accountId: string, threadCount: number) => void
  onError: (message: string) => void
}

export interface BackfillResult {
  accountId: string
  threadCount: number
  inboxThreadIds: string[]
}

export interface BackfillOptions {
  /** Start a fresh delta re-list even if an earlier backfill completed. */
  restart?: boolean
}

export async function runInboxBackfill(
  db: Db,
  provider: MailProvider,
  cb: BackfillCallbacks,
  options: BackfillOptions = {}
): Promise<BackfillResult | null> {
  try {
    const profile = await provider.getProfile()
    const accountId = profile.emailAddress

    ensureAccount(db, accountId, profile.emailAddress)

    const prev = db
      .prepare('SELECT backfill_cursor, updated_at FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null; updated_at: number | null } | undefined
    if (prev?.backfill_cursor === 'done' && !options.restart) {
      cb.onDone(accountId, 0)
      return { accountId, threadCount: 0, inboxThreadIds: [] }
    }

    const resumeCursor = prev?.backfill_cursor
    const resuming = Boolean(!options.restart && resumeCursor && resumeCursor !== 'done')
    let pageToken: string | undefined =
      resuming && resumeCursor !== 'start' && resumeCursor !== 'reconcile'
        ? (resumeCursor ?? undefined)
        : undefined
    if (!resuming) {
      // Checkpoint before listing. The 'start' sentinel distinguishes an
      // interrupted first page from a legacy NULL cursor and preserves the
      // original history id across relaunches.
      db.prepare(
        `INSERT INTO sync_state (account_id, last_history_id, backfill_cursor, updated_at)
         VALUES (?, ?, 'start', 0)
         ON CONFLICT(account_id) DO UPDATE SET
           last_history_id = excluded.last_history_id,
           backfill_cursor = excluded.backfill_cursor,
           updated_at = excluded.updated_at`
      ).run(accountId, profile.historyId)
    }

    upsertLabels(db, accountId, await provider.listLabels())

    let done = 0
    const inboxThreadIds = new Set<string>()
    if (resumeCursor !== 'reconcile') {
      do {
        const page = await provider.listThreadIds('newer_than:12m', pageToken)

        await mapConcurrent(page.threadIds, 3, async (threadId) => {
          try {
            persistThread(db, accountId, await provider.getThread(threadId))
          } catch (e) {
            // Normal race on an active inbox: listed thread archived/deleted
            // before we fetched it. Skip it, keep the backfill alive.
            if (e instanceof GmailApiError && e.status === 404) {
              console.log(`[sync] thread ${threadId} vanished mid-backfill — skipped`)
              return
            }
            throw e
          }
          done++
        })

        cb.onProgress(done)
        pageToken = page.nextPageToken
        db.prepare('UPDATE sync_state SET backfill_cursor = ?, updated_at = 0 WHERE account_id = ?').run(
          pageToken ?? 'reconcile',
          accountId
        )
      } while (pageToken)
    }

    // Re-list ids only after the body backfill. This is both the complete set
    // used for INBOX reconciliation and a resumable final phase after a kill.
    pageToken = undefined
    do {
      const page = await provider.listThreadIds('newer_than:12m', pageToken)
      for (const threadId of page.threadIds) inboxThreadIds.add(threadId)
      pageToken = page.nextPageToken
    } while (pageToken)

    db.prepare('UPDATE sync_state SET backfill_cursor = ?, updated_at = ? WHERE account_id = ?').run(
      'done',
      Date.now(),
      accountId
    )

    cb.onDone(accountId, done)
    return { accountId, threadCount: done, inboxThreadIds: [...inboxThreadIds] }
  } catch (e) {
    cb.onError(e instanceof Error ? e.message : String(e))
    return null
  }
}

async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}
