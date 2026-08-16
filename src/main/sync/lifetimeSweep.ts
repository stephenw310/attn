// Low-priority, resumable account-wide header indexing. The interactive backfill
// stays responsible for readiness; this walk only improves lifetime recall.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { type SchedulerTime, systemTime } from '../time'
import { persistThread } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'

export const LIFETIME_REQUEST_INTERVAL_MS = 100
export const LIFETIME_PAGE_PAUSE_MS = 1_000
export const LIFETIME_FOREGROUND_YIELD_MS = 250

export interface LifetimeSweepProgress {
  threadsDone: number
  threadsTotal?: number
  messagesTotal?: number
  etaMs?: number
  reason: 'running' | 'quota-wait' | 'foreground-yield'
  waitMs?: number
  mailChanged: boolean
}

export interface LifetimeSweepCallbacks {
  onProgress: (progress: LifetimeSweepProgress) => void
  onError: (error: unknown) => void
}

export interface LifetimeSweepOptions {
  time?: SchedulerTime
  requestIntervalMs?: number
  pagePauseMs?: number
  foregroundYieldMs?: number
  /** True while foreground Gmail work should get the next request slot. */
  shouldYield?: () => boolean
  /** Cancels future requests and, critically, all writes after an awaited request. */
  shouldContinue?: () => boolean
}

export interface LifetimeSweepResult {
  threadCount: number
}

export type LifetimeSweepStartPlan =
  | { kind: 'skip' }
  | { kind: 'run'; pageToken?: string; initialize: boolean }

export function planLifetimeSweepStart(rawCursor: string | null | undefined): LifetimeSweepStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  if (!rawCursor || rawCursor === 'lifetime') return { kind: 'run', initialize: !rawCursor }
  if (rawCursor.startsWith('lifetime:') && rawCursor.length > 'lifetime:'.length) {
    return {
      kind: 'run',
      pageToken: rawCursor.slice('lifetime:'.length),
      initialize: false
    }
  }
  throw new Error(`Invalid lifetime sweep cursor: ${rawCursor}`)
}

/**
 * Walk Gmail's default, newest-first thread listing with no query or label filter.
 * A page is checkpointed only after every new thread on it has been durably stored.
 */
export async function runLifetimeSweep(
  db: Db,
  provider: MailProvider,
  accountId: string,
  callbacks: LifetimeSweepCallbacks,
  options: LifetimeSweepOptions = {}
): Promise<LifetimeSweepResult | null> {
  const time = options.time ?? systemTime
  const shouldContinue = options.shouldContinue ?? (() => true)
  const shouldYield = options.shouldYield ?? (() => false)
  const requestIntervalMs = options.requestIntervalMs ?? LIFETIME_REQUEST_INTERVAL_MS
  const pagePauseMs = options.pagePauseMs ?? LIFETIME_PAGE_PAUSE_MS
  const foregroundYieldMs = options.foregroundYieldMs ?? LIFETIME_FOREGROUND_YIELD_MS
  let lastRequestAt: number | null = null
  const startedAt = time.now()
  const startingThreadsDone = storedThreadCount(db, accountId)

  const progress = (
    reason: LifetimeSweepProgress['reason'],
    threadsTotal: number | undefined,
    messagesTotal: number | undefined,
    mailChanged = false,
    waitMs?: number
  ): void => {
    const threadsDone = storedThreadCount(db, accountId, threadsTotal)
    const etaMs = estimateRemainingMs(threadsDone, threadsTotal, startingThreadsDone, time.now() - startedAt)
    callbacks.onProgress({
      threadsDone,
      threadsTotal,
      messagesTotal,
      ...(etaMs === undefined ? {} : { etaMs }),
      reason,
      ...(waitMs === undefined ? {} : { waitMs }),
      mailChanged
    })
  }

  const wait = async (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) return shouldContinue()
    await new Promise<void>((resolve) => time.timers.setTimeout(resolve, delayMs))
    return shouldContinue()
  }

  const waitForRequestSlot = async (
    threadsTotal: number | undefined,
    messagesTotal: number | undefined
  ): Promise<boolean> => {
    let yielded = false
    while (shouldContinue() && shouldYield()) {
      yielded = true
      progress('foreground-yield', threadsTotal, messagesTotal, false, foregroundYieldMs)
      if (!(await wait(foregroundYieldMs))) return false
    }
    if (!shouldContinue()) return false
    if (yielded) progress('running', threadsTotal, messagesTotal)

    if (lastRequestAt !== null) {
      const remaining = requestIntervalMs - (time.now() - lastRequestAt)
      if (remaining > 0 && !(await wait(remaining))) return false
    }
    lastRequestAt = time.now()
    return shouldContinue()
  }

  try {
    const state = db.prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
      | { sweep_cursor: string | null }
      | undefined
    const plan = planLifetimeSweepStart(state?.sweep_cursor)
    if (plan.kind === 'skip') return { threadCount: storedThreadCount(db, accountId) }

    if (plan.initialize) {
      db.prepare('UPDATE sync_state SET sweep_cursor = ? WHERE account_id = ?').run('lifetime', accountId)
    }

    if (!(await waitForRequestSlot(undefined, undefined))) return null
    const profile = await provider.getProfile()
    if (!shouldContinue()) return null
    let threadsTotal = profile.threadsTotal
    const messagesTotal = profile.messagesTotal
    progress('running', threadsTotal, messagesTotal)

    const exists = db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?')
    let pageToken = plan.pageToken
    let resetExpiredCursor = false

    for (;;) {
      if (!(await waitForRequestSlot(threadsTotal, messagesTotal))) return null
      let page: ThreadIdPage
      try {
        // Deliberately empty: Gmail's default listing covers the whole account
        // except Spam and Trash, which become explicit stages in M3.
        page = await provider.listThreadIds({ pageToken })
      } catch (error) {
        if (!pageToken || resetExpiredCursor || !isExpiredPageToken(error)) throw error
        pageToken = undefined
        resetExpiredCursor = true
        checkpoint(db, accountId, 'lifetime')
        continue
      }
      if (!shouldContinue()) return null
      threadsTotal ??= page.resultSizeEstimate

      let mailChanged = false
      for (const threadId of page.threadIds) {
        if (!shouldContinue()) return null
        if (exists.get(accountId, threadId)) continue
        if (!(await waitForRequestSlot(threadsTotal, messagesTotal))) return null
        try {
          const thread = await provider.getThread(threadId, { format: 'metadata' })
          if (!shouldContinue()) return null
          persistThread(db, accountId, thread, { metadataOnly: true })
          mailChanged = true
        } catch (error) {
          // A moving mailbox can drop a listed thread before its metadata fetch.
          if (error instanceof GmailApiError && error.status === 404) continue
          throw error
        }
      }

      pageToken = page.nextPageToken
      checkpoint(db, accountId, pageToken ? `lifetime:${pageToken}` : 'done')
      progress('running', threadsTotal, messagesTotal, mailChanged)
      if (!pageToken) {
        return { threadCount: storedThreadCount(db, accountId, threadsTotal) }
      }

      progress('quota-wait', threadsTotal, messagesTotal, false, pagePauseMs)
      if (!(await wait(pagePauseMs))) return null
      progress('running', threadsTotal, messagesTotal)
    }
  } catch (error) {
    if (shouldContinue()) callbacks.onError(error)
    return null
  }
}

function storedThreadCount(db: Db, accountId: string, total?: number): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE account_id = ?').get(accountId) as {
    count: number
  }
  return total === undefined ? row.count : Math.min(row.count, total)
}

function estimateRemainingMs(
  threadsDone: number,
  threadsTotal: number | undefined,
  startingThreadsDone: number,
  elapsedMs: number
): number | undefined {
  if (threadsTotal === undefined || threadsDone >= threadsTotal || elapsedMs <= 0) return undefined
  const completedThisRun = threadsDone - startingThreadsDone
  if (completedThisRun <= 0) return undefined
  return Math.ceil(((threadsTotal - threadsDone) * elapsedMs) / completedThisRun)
}

function checkpoint(db: Db, accountId: string, cursor: string): void {
  db.prepare('UPDATE sync_state SET sweep_cursor = ? WHERE account_id = ?').run(cursor, accountId)
}

function isExpiredPageToken(error: unknown): boolean {
  return error instanceof GmailApiError && (error.status === 400 || error.status === 404)
}
