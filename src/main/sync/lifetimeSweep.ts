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

interface StoredSweepState {
  sweep_cursor: string | null
  sweep_threads_done: number
  sweep_threads_total: number | null
}

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
 * A page and its processed count are checkpointed only after every id on it has
 * either been skipped or durably stored.
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
  let activeElapsedMs = 0

  const wait = async (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) return shouldContinue()
    await new Promise<void>((resolve) => time.timers.setTimeout(resolve, delayMs))
    return shouldContinue()
  }

  try {
    const state = db
      .prepare(
        `SELECT sweep_cursor, sweep_threads_done, sweep_threads_total
         FROM sync_state WHERE account_id = ?`
      )
      .get(accountId) as StoredSweepState | undefined
    const plan = planLifetimeSweepStart(state?.sweep_cursor)
    if (plan.kind === 'skip') return { threadCount: state?.sweep_threads_done ?? 0 }

    const checkpoint = db.prepare(
      `UPDATE sync_state
       SET sweep_cursor = ?, sweep_threads_done = ?, sweep_threads_total = ?
       WHERE account_id = ?`
    )
    let threadsDone = state?.sweep_threads_done ?? 0
    let threadsTotal = state?.sweep_threads_total ?? undefined
    let startingThreadsDone = threadsDone
    if (plan.initialize) {
      threadsDone = 0
      threadsTotal = undefined
      startingThreadsDone = 0
      checkpoint.run('lifetime', 0, null, accountId)
    }

    let messagesTotal: number | undefined
    const progress = (
      reason: LifetimeSweepProgress['reason'],
      mailChanged = false,
      waitMs?: number
    ): void => {
      const etaMs = estimateRemainingMs(threadsDone, threadsTotal, startingThreadsDone, activeElapsedMs)
      callbacks.onProgress({
        threadsDone,
        ...(threadsTotal === undefined ? {} : { threadsTotal }),
        ...(messagesTotal === undefined ? {} : { messagesTotal }),
        ...(etaMs === undefined ? {} : { etaMs }),
        reason,
        ...(waitMs === undefined ? {} : { waitMs }),
        mailChanged
      })
    }

    const waitForRequestSlot = async (): Promise<boolean> => {
      let yielded = false
      while (shouldContinue() && shouldYield()) {
        yielded = true
        progress('foreground-yield', false, foregroundYieldMs)
        if (!(await wait(foregroundYieldMs))) return false
      }
      if (!shouldContinue()) return false
      if (yielded) progress('running')

      if (lastRequestAt !== null) {
        const remaining = requestIntervalMs - (time.now() - lastRequestAt)
        if (remaining > 0 && !(await wait(remaining))) return false
      }
      lastRequestAt = time.now()
      return shouldContinue()
    }

    const activeRequest = async <T>(request: () => Promise<T>): Promise<T> => {
      const requestStartedAt = time.now()
      try {
        return await request()
      } finally {
        activeElapsedMs += Math.max(0, time.now() - requestStartedAt)
      }
    }

    if (!(await waitForRequestSlot())) return null
    const profile = await provider.getProfile()
    if (!shouldContinue()) return null
    const profileThreadsTotal = profile.threadsTotal
    messagesTotal = profile.messagesTotal
    progress('running')

    const exists = db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?')
    let pageToken = plan.pageToken
    let resetExpiredCursor = false

    for (;;) {
      if (!(await waitForRequestSlot())) return null
      let page: ThreadIdPage
      try {
        // Deliberately empty: Gmail's default listing covers the whole account
        // except Spam and Trash, which become explicit stages in M3.
        page = await activeRequest(() => provider.listThreadIds({ pageToken }))
      } catch (error) {
        if (!pageToken || resetExpiredCursor || !isExpiredPageToken(error)) throw error
        pageToken = undefined
        resetExpiredCursor = true
        threadsDone = 0
        threadsTotal = undefined
        startingThreadsDone = 0
        activeElapsedMs = 0
        checkpoint.run('lifetime', 0, null, accountId)
        continue
      }
      if (!shouldContinue()) return null
      threadsTotal ??= page.resultSizeEstimate ?? profileThreadsTotal

      let mailChanged = false
      for (const threadId of page.threadIds) {
        if (!shouldContinue()) return null
        if (exists.get(accountId, threadId)) {
          threadsDone++
          continue
        }
        if (!(await waitForRequestSlot())) return null
        try {
          const thread = await activeRequest(() => provider.getThread(threadId, { format: 'metadata' }))
          if (!shouldContinue()) return null
          mailChanged =
            persistThread(db, accountId, thread, {
              metadataOnly: true,
              inboxVisibility: 'hide'
            }) || mailChanged
        } catch (error) {
          // A moving mailbox can drop a listed thread before its metadata fetch.
          if (!(error instanceof GmailApiError) || error.status !== 404) throw error
        }
        threadsDone++
      }

      pageToken = page.nextPageToken
      if (!pageToken) threadsTotal = threadsDone
      checkpoint.run(pageToken ? `lifetime:${pageToken}` : 'done', threadsDone, threadsTotal, accountId)
      progress('running', mailChanged)
      if (!pageToken) return { threadCount: threadsDone }

      progress('quota-wait', false, pagePauseMs)
      if (!(await wait(pagePauseMs))) return null
      progress('running')
    }
  } catch (error) {
    if (shouldContinue()) callbacks.onError(error)
    return null
  }
}

function estimateRemainingMs(
  threadsDone: number,
  threadsTotal: number | undefined,
  startingThreadsDone: number,
  activeElapsedMs: number
): number | undefined {
  if (threadsTotal === undefined || threadsDone >= threadsTotal || activeElapsedMs <= 0) return undefined
  const completedThisRun = threadsDone - startingThreadsDone
  if (completedThisRun <= 0) return undefined
  return Math.ceil(((threadsTotal - threadsDone) * activeElapsedMs) / completedThisRun)
}

function isExpiredPageToken(error: unknown): boolean {
  return error instanceof GmailApiError && (error.status === 400 || error.status === 404)
}
