// Resumable local pass that indexes messages written before revision 18 (or by
// a manually upgraded dogfood profile). Ordinary writes index inline through
// `persistThread`, so on a freshly synced profile this pass finds nothing and
// marks itself done. It is the fourth sync cursor: purely local, running at
// background priority behind the three Gmail cursors and yielding to
// interactive work (M3 global rule 7).

import type { Db } from '../db'
import { type SchedulerTime, systemTime } from '../time'
import { type FtsWriteCounts, indexStoredMessages } from './fts'
import { FTS_BACKFILL_BATCH_PAUSE_MS, FTS_BACKFILL_BATCH_SIZE, LIFETIME_FOREGROUND_YIELD_MS } from './tuning'

const CURSOR_PHASE = 'fts'

export type FtsBackfillStartPlan = { kind: 'skip' } | { kind: 'run'; afterMessageId?: string }

/** Same `phase` / `phase:checkpoint` / `done` grammar as the other three cursors. */
export function planFtsBackfillStart(rawCursor: string | null | undefined): FtsBackfillStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  if (!rawCursor || rawCursor === CURSOR_PHASE) return { kind: 'run' }
  if (rawCursor.startsWith(`${CURSOR_PHASE}:`) && rawCursor.length > CURSOR_PHASE.length + 1) {
    return { kind: 'run', afterMessageId: rawCursor.slice(CURSOR_PHASE.length + 1) }
  }
  throw new Error(`Invalid FTS backfill cursor: ${rawCursor}`)
}

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
  const time = options.time ?? systemTime
  const shouldContinue = options.shouldContinue ?? (() => true)
  const shouldYield = options.shouldYield ?? (() => false)
  const batchSize = options.batchSize ?? FTS_BACKFILL_BATCH_SIZE
  const batchPauseMs = options.batchPauseMs ?? FTS_BACKFILL_BATCH_PAUSE_MS
  const foregroundYieldMs = options.foregroundYieldMs ?? LIFETIME_FOREGROUND_YIELD_MS
  let messagesIndexed = 0

  const progress = (reason: FtsBackfillProgress['reason'], waitMs?: number): void => {
    callbacks.onProgress({ messagesIndexed, reason, ...(waitMs === undefined ? {} : { waitMs }) })
  }

  const wait = async (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) return shouldContinue()
    await new Promise<void>((resolve) => time.timers.setTimeout(resolve, delayMs))
    return shouldContinue()
  }

  const waitForBatchSlot = async (): Promise<boolean> => {
    let yielded = false
    while (shouldContinue() && shouldYield()) {
      yielded = true
      progress('foreground-yield', foregroundYieldMs)
      if (!(await wait(foregroundYieldMs))) return false
    }
    if (!shouldContinue()) return false
    if (yielded) progress('running')
    return true
  }

  try {
    // Unit and upgrade scenarios can hold messages without a sync_state row;
    // the cursor UPDATE below must never be a silent no-op.
    db.prepare('INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)').run(accountId)
    const state = db.prepare('SELECT fts_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
      | { fts_cursor: string | null }
      | undefined
    const plan = planFtsBackfillStart(state?.fts_cursor)
    if (plan.kind === 'skip') return { messagesIndexed: 0 }

    const checkpoint = db.prepare('UPDATE sync_state SET fts_cursor = ? WHERE account_id = ?')
    // Rows indexed inline by `persistThread` fall out of the anti-join, so the
    // pass touches only what actually needs indexing.
    const selectBatch = db.prepare(
      `SELECT m.id
       FROM messages m
       LEFT JOIN message_fts_map map ON map.account_id = m.account_id AND map.message_id = m.id
       WHERE m.account_id = ? AND m.id > ? AND map.fts_rowid IS NULL
       ORDER BY m.id
       LIMIT ?`
    )
    let afterMessageId = plan.afterMessageId ?? ''
    let batchIndex = 0

    for (;;) {
      if (!(await waitForBatchSlot())) return null
      const batch = (selectBatch.all(accountId, afterMessageId, batchSize) as { id: string }[]).map(
        (row) => row.id
      )
      const cursor = batch.length < batchSize ? 'done' : `${CURSOR_PHASE}:${batch[batch.length - 1]}`
      db.transaction(() => {
        const counts: FtsWriteCounts = indexStoredMessages(db, accountId, batch)
        checkpoint.run(cursor, accountId)
        messagesIndexed += counts.inserted
      })()
      progress('running')
      await options.onBatchCheckpoint?.({ batchIndex, cursor })
      batchIndex++
      if (cursor === 'done') return { messagesIndexed }
      afterMessageId = batch[batch.length - 1]
      if (!(await wait(batchPauseMs))) return null
    }
  } catch (error) {
    if (shouldContinue()) callbacks.onError(error)
    return null
  }
}
