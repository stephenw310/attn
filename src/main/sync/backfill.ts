// Resumable staged INBOX backfill: 12 months of metadata first, then full
// bodies for 90 days. Each completed page checkpoints the next phase/token.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { hydrateMissingThreadBodies } from './bodies'
import { ensureAccount, persistThread, upsertLabels } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'

export interface BackfillCallbacks {
  onProgress: (progress: BackfillProgress) => void
  onError: (error: unknown) => void
}

export interface BackfillProgress {
  stage: BackfillPhase
  threadsDone: number
}

export interface BackfillResult {
  threadCount: number
  inboxThreadIds: string[]
}

export interface BackfillOptions {
  /** Restart a completed backfill, but resume one already in progress. */
  recovery?: boolean
}

export type BackfillPhase = 'metadata' | 'bodies' | 'reconcile'

interface ParsedCursor {
  phase: BackfillPhase
  pageToken?: string
}

export async function runInboxBackfill(
  db: Db,
  provider: MailProvider,
  callbacks: BackfillCallbacks,
  options: BackfillOptions = {}
): Promise<BackfillResult | null> {
  try {
    const profile = await provider.getProfile()
    const accountId = profile.emailAddress
    ensureAccount(db, accountId, profile.emailAddress)

    const previous = db
      .prepare('SELECT backfill_cursor, updated_at FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null; updated_at: number | null } | undefined
    if (previous?.backfill_cursor === 'done' && !options.recovery) {
      return { threadCount: 0, inboxThreadIds: [] }
    }

    const resuming = Boolean(previous?.backfill_cursor && previous.backfill_cursor !== 'done')
    let cursor = resuming ? parseCursor(previous?.backfill_cursor) : { phase: 'metadata' as const }
    if (!resuming) {
      // Record the gapless history checkpoint before the first metadata page.
      db.prepare(
        `INSERT INTO sync_state (account_id, last_history_id, backfill_cursor, updated_at)
         VALUES (?, ?, 'metadata', 0)
         ON CONFLICT(account_id) DO UPDATE SET
           last_history_id = excluded.last_history_id,
           backfill_cursor = excluded.backfill_cursor,
           updated_at = excluded.updated_at`
      ).run(accountId, profile.historyId)
    }

    upsertLabels(db, accountId, await provider.listLabels())
    let threadsDone = 0

    if (cursor.phase === 'metadata') {
      callbacks.onProgress({ stage: 'metadata', threadsDone })
      await runThreadPhase({
        db,
        provider,
        accountId,
        query: 'newer_than:12m',
        phase: 'metadata',
        initialPageToken: cursor.pageToken,
        nextPhase: 'bodies',
        onThread: async (threadId) => {
          persistThread(db, accountId, await provider.getThread(threadId, { format: 'metadata' }), {
            metadataOnly: true
          })
        },
        onPage: (count) => {
          threadsDone += count
          callbacks.onProgress({ stage: 'metadata', threadsDone })
        }
      })
      cursor = { phase: 'bodies' }
    }

    if (cursor.phase === 'bodies') {
      callbacks.onProgress({ stage: 'bodies', threadsDone })
      await runThreadPhase({
        db,
        provider,
        accountId,
        query: 'newer_than:90d',
        phase: 'bodies',
        initialPageToken: cursor.pageToken,
        nextPhase: 'reconcile',
        onThread: async (threadId) => {
          const thread = await provider.getThread(threadId, { format: 'full' })
          persistThread(db, accountId, thread)
          await hydrateMissingThreadBodies(db, provider, accountId, thread)
        },
        onPage: (count) => {
          threadsDone += count
          callbacks.onProgress({ stage: 'bodies', threadsDone })
        }
      })
    }

    // Re-list all INBOX ids for authoritative membership reconciliation. This
    // remains metadata-free and prevents older local threads being stripped.
    callbacks.onProgress({ stage: 'reconcile', threadsDone })
    const inboxThreadIds = new Set<string>()
    let pageToken: string | undefined
    do {
      const page = await provider.listThreadIds('', pageToken)
      for (const threadId of page.threadIds) inboxThreadIds.add(threadId)
      pageToken = page.nextPageToken
    } while (pageToken)

    db.prepare('UPDATE sync_state SET backfill_cursor = ?, updated_at = ? WHERE account_id = ?').run(
      'done',
      Date.now(),
      accountId
    )
    return { threadCount: threadsDone, inboxThreadIds: [...inboxThreadIds] }
  } catch (error) {
    callbacks.onError(error)
    return null
  }
}

interface ThreadPhaseOptions {
  db: Db
  provider: MailProvider
  accountId: string
  query: string
  phase: Exclude<BackfillPhase, 'reconcile'>
  initialPageToken?: string
  nextPhase: BackfillPhase
  onThread: (threadId: string) => Promise<void>
  onPage: (count: number) => void
}

async function runThreadPhase(options: ThreadPhaseOptions): Promise<void> {
  let pageToken = options.initialPageToken
  let resetExpiredCursor = false
  for (;;) {
    let page: ThreadIdPage
    try {
      page = await options.provider.listThreadIds(options.query, pageToken)
    } catch (error) {
      if (!pageToken || resetExpiredCursor || !isExpiredPageToken(error)) throw error
      // Preserve the original history checkpoint while restarting this phase.
      pageToken = undefined
      resetExpiredCursor = true
      checkpoint(options.db, options.accountId, options.phase)
      continue
    }

    let completed = 0
    await mapConcurrent(page.threadIds, 3, async (threadId) => {
      try {
        await options.onThread(threadId)
      } catch (error) {
        // Normal race on an active inbox: listed thread disappeared before get.
        if (error instanceof GmailApiError && error.status === 404) {
          console.log(`[sync] thread ${threadId} vanished mid-backfill — skipped`)
          return
        }
        throw error
      }
      completed++
    })
    if (completed > 0) options.onPage(completed)
    pageToken = page.nextPageToken
    checkpoint(options.db, options.accountId, pageToken ? `${options.phase}:${pageToken}` : options.nextPhase)
    if (!pageToken) return
  }
}

function parseCursor(raw: string | null | undefined): ParsedCursor {
  if (!raw || raw === 'start' || raw === 'metadata') return { phase: 'metadata' }
  if (raw === 'bodies') return { phase: 'bodies' }
  if (raw === 'reconcile') return { phase: 'reconcile' }
  if (raw.startsWith('metadata:')) return { phase: 'metadata', pageToken: raw.slice('metadata:'.length) }
  if (raw.startsWith('bodies:')) return { phase: 'bodies', pageToken: raw.slice('bodies:'.length) }
  // Compatibility with the first T7 cursor format, which stored a bare token.
  return { phase: 'metadata', pageToken: raw }
}

function checkpoint(db: Db, accountId: string, cursor: string): void {
  db.prepare('UPDATE sync_state SET backfill_cursor = ?, updated_at = 0 WHERE account_id = ?').run(
    cursor,
    accountId
  )
}

function isExpiredPageToken(error: unknown): boolean {
  return error instanceof GmailApiError && (error.status === 400 || error.status === 404)
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
