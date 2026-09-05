// Resumable local pass that indexes messages written before revision 18 (or by
// a manually upgraded dogfood profile). Ordinary writes index inline through
// `persistThread`, so on a freshly synced profile this pass finds nothing and
// marks itself done. It is the fourth sync cursor: purely local, running at
// background priority behind the three Gmail cursors and yielding to
// interactive work (M3 global rule 7).

import type { Db } from '../db'
import type { SchedulerTime } from '../time'
import { type CursorWalkReason, lazyStatement, planCursorStart, runCursorWalk } from './cursorWalk'
import { type FtsWriteCounts, indexStoredMessages } from './fts'
import { FTS_BACKFILL_BATCH_PAUSE_MS, FTS_BACKFILL_BATCH_SIZE } from './tuning'

const CURSOR_PHASE = 'fts'

export interface FtsBackfillProgress {
  messagesIndexed: number
  reason: 'running' | 'foreground-yield'
  waitMs?: number
}

export interface FtsBackfillCallbacks {
  onProgress: (progress: FtsBackfillProgress) => void
  onError: (error: unknown) => void
}

export interface FtsBackfillOptions {
  time?: SchedulerTime
  batchSize?: number
  batchPauseMs?: number
  foregroundYieldMs?: number
  /** True while interactive Gmail or store work should get the next slot. */
  shouldYield?: () => boolean
  /** Cancels future batches; the committed cursor stays durable. */
  shouldContinue?: () => boolean
  /** Awaited after each committed batch; the crash e2e hangs here. */
  onBatchCheckpoint?: (checkpoint: { batchIndex: number; cursor: string }) => Promise<void> | void
}

export interface FtsBackfillResult {
  messagesIndexed: number
}

/**
 * Walk stored messages in id order, indexing every row the map does not hold
 * yet. Each batch commits its index writes and its cursor in one transaction,
 * so a supervisor restart resumes from the last durable checkpoint.
 */
export async function runFtsBackfill(
  db: Db,
  accountId: string,
  callbacks: FtsBackfillCallbacks,
  options: FtsBackfillOptions = {}
): Promise<FtsBackfillResult | null> {
  const batchSize = options.batchSize ?? FTS_BACKFILL_BATCH_SIZE
  let messagesIndexed = 0
  let batchIndex = 0

  // A local pass waits on nothing but its own pacing, so the walk's
  // between-batch pause is silent and only these two reasons are reported.
  const progress = (reason: CursorWalkReason, waitMs?: number): void => {
    callbacks.onProgress({
      messagesIndexed,
      reason: reason === 'foreground-yield' ? reason : 'running',
      ...(waitMs === undefined ? {} : { waitMs })
    })
  }

  // Rows indexed inline by `persistThread` fall out of the anti-join, so the
  // pass touches only what actually needs indexing.
  const selectBatch = lazyStatement(() =>
    db.prepare(
      `SELECT m.id
       FROM messages m
       LEFT JOIN message_fts_map map ON map.account_id = m.account_id AND map.message_id = m.id
       WHERE m.account_id = ? AND m.id > ? AND map.fts_rowid IS NULL
       ORDER BY m.id
       LIMIT ?`
    )
  )

  return runCursorWalk<string[], FtsBackfillResult>({
    db,
    accountId,
    cursorColumn: 'fts_cursor',
    phase: CURSOR_PHASE,
    parseCursor: (cursor) => planCursorStart(CURSOR_PHASE, cursor, 'FTS backfill'),
    time: options.time,
    pagePauseMs: options.batchPauseMs ?? FTS_BACKFILL_BATCH_PAUSE_MS,
    foregroundYieldMs: options.foregroundYieldMs,
    pauseReason: null,
    shouldYield: options.shouldYield,
    shouldContinue: options.shouldContinue,
    ensureSyncStateRow: true,
    progress,
    onError: callbacks.onError,
    onSkip: () => ({ messagesIndexed: 0 }),
    listPage: async (afterMessageId) =>
      (selectBatch().all(accountId, afterMessageId ?? '', batchSize) as { id: string }[]).map(
        (row) => row.id
      ),
    nextToken: (batch) => (batch.length < batchSize ? undefined : batch[batch.length - 1]),
    onPage: async () => {},
    commitPage: (batch, applyCursor) => {
      db.transaction(() => {
        const counts: FtsWriteCounts = indexStoredMessages(db, accountId, batch)
        applyCursor()
        messagesIndexed += counts.inserted
      })()
    },
    afterCheckpoint: async (cursor) => {
      await options.onBatchCheckpoint?.({ batchIndex, cursor })
      batchIndex++
    },
    onFinish: () => ({ messagesIndexed })
  })
}
