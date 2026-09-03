// Low-priority, resumable account-wide header indexing. The interactive backfill
// stays responsible for readiness; this walk only improves lifetime recall.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { type SchedulerTime, systemTime } from '../time'
import { isExpiredPageTokenError } from './pageToken'
import { persistThread } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'
import {
  LIFETIME_FOREGROUND_YIELD_MS,
  LIFETIME_PAGE_PAUSE_MS,
  LIFETIME_REQUEST_INTERVAL_MS,
  LIFETIME_THREAD_CAP,
  LIFETIME_THREAD_CAP_UNLIMITED
} from './tuning'

export interface LifetimeSweepProgress {
  threadsDone: number
  threadsTotal?: number
  messagesTotal?: number
  etaMs?: number
  elapsedMs?: number
  threadsPerMinute?: number
  quotaWaitMs?: number
  reason: 'running' | 'quota-wait' | 'foreground-yield'
  waitMs?: number
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
  /** Conversations to keep locally, newest first. 0 stores the whole account. */
  threadCap?: number
}

export interface LifetimeSweepResult {
  threadCount: number
  elapsedMs: number
  threadsPerMinute?: number
  quotaWaitMs: number
}

export type LifetimeSweepStartPlan =
  | { kind: 'skip' }
  | { kind: 'run'; pageToken?: string; initialize: boolean }

interface StoredSweepState {
  sweep_cursor: string | null
  sweep_threads_done: number
  sweep_threads_total: number | null
}

interface IndexedThreadCount {
  count: number
}

export function planLifetimeSweepStart(rawCursor: string | null | undefined): LifetimeSweepStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  // A capped walk retains the current page. Only an exhausted listing is done.
  if (rawCursor?.startsWith('capped:')) rawCursor = rawCursor.slice('capped:'.length)
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
  const threadCap = options.threadCap ?? LIFETIME_THREAD_CAP
  let lastRequestAt: number | null = null
  let threadsIndexedBySweep = 0
  let indexingElapsedMs = 0
  const startedAt = time.now()
  const quotaWaitStartedAt = provider.quotaMetrics?.().waitMs ?? 0
  const quotaWaitMs = (): number =>
    Math.max(0, (provider.quotaMetrics?.().waitMs ?? quotaWaitStartedAt) - quotaWaitStartedAt)

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
    if (plan.kind === 'skip') {
      return { threadCount: state?.sweep_threads_done ?? 0, elapsedMs: 0, quotaWaitMs: 0 }
    }

    const checkpoint = db.prepare(
      `UPDATE sync_state
       SET sweep_cursor = ?, sweep_threads_done = ?, sweep_threads_total = ?
       WHERE account_id = ?`
    )
    // The durable count belongs to the listing cursor: it says how many ids the
    // sweep has walked, including rows that an earlier stage already stored.
    // User-visible progress has a different numerator — unique thread metadata
    // currently present in the local account store.
    let listedThreadsDone = state?.sweep_threads_done ?? 0
    let startingListedThreadsDone = listedThreadsDone
    // Never publish the saved total before refreshing the Gmail profile: old
    // builds stored `resultSizeEstimate` here, including impossible values.
    let threadsTotal: number | undefined
    if (plan.initialize) {
      listedThreadsDone = 0
      startingListedThreadsDone = 0
      checkpoint.run('lifetime', 0, null, accountId)
    }

    const runMetrics = (): Pick<LifetimeSweepResult, 'elapsedMs' | 'threadsPerMinute' | 'quotaWaitMs'> => {
      const elapsedMs = Math.max(0, time.now() - startedAt)
      const processedThisRun = Math.max(0, listedThreadsDone - startingListedThreadsDone)
      return {
        elapsedMs,
        ...(processedThisRun > 0 && elapsedMs > 0
          ? { threadsPerMinute: Math.round((processedThisRun * 60_000) / elapsedMs) }
          : {}),
        quotaWaitMs: quotaWaitMs()
      }
    }

    const indexedThreadCount = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE account_id = ?')
    const countIndexedThreads = (): number => (indexedThreadCount.get(accountId) as IndexedThreadCount).count
    let threadsIndexed = countIndexedThreads()
    const atCap = (): boolean => threadCap !== LIFETIME_THREAD_CAP_UNLIMITED && threadsIndexed >= threadCap
    const stopAtCap = (pageToken: string | undefined, pageStartCount: number): LifetimeSweepResult => {
      // Replay the partial page on resume. Its starting count must accompany
      // the cursor, or already-stored ids on that page would be counted twice.
      checkpoint.run(
        `capped:${pageToken ? `lifetime:${pageToken}` : 'lifetime'}`,
        pageStartCount,
        threadsTotal ?? state?.sweep_threads_total ?? null,
        accountId
      )
      console.log(`[sync] lifetime sweep stopped at the ${threadCap}-conversation limit for ${accountId}`)
      return { threadCount: listedThreadsDone, ...runMetrics() }
    }
    // An unchanged or lower cap needs no Gmail requests on the next launch.
    if (atCap()) return stopAtCap(plan.pageToken, listedThreadsDone)

    let messagesTotal: number | undefined
    const progress = (reason: LifetimeSweepProgress['reason'], waitMs?: number): void => {
      // `threadsIndexed` is refreshed once per listing page, never here: this
      // count scans every stored thread id for the account, and progress is
      // reported on every 250 ms foreground yield while the sweep waits for
      // the single utility-process connection.
      // The account total describes coverage. ETA describes this sweep, which
      // stops at the local cap even when Gmail has more conversations.
      const targetThreads =
        threadsTotal === undefined || threadCap === LIFETIME_THREAD_CAP_UNLIMITED
          ? threadsTotal
          : Math.min(threadsTotal, threadCap)
      const etaMs = estimateRemainingMs(
        threadsIndexed,
        targetThreads,
        threadsIndexedBySweep,
        indexingElapsedMs
      )
      callbacks.onProgress({
        threadsDone: threadsIndexed,
        ...(threadsTotal === undefined ? {} : { threadsTotal }),
        ...(messagesTotal === undefined ? {} : { messagesTotal }),
        ...(etaMs === undefined ? {} : { etaMs }),
        ...runMetrics(),
        reason,
        ...(waitMs === undefined ? {} : { waitMs })
      })
    }

    const waitForRequestSlot = async (): Promise<boolean> => {
      let yielded = false
      while (shouldContinue() && shouldYield()) {
        yielded = true
        progress('foreground-yield', foregroundYieldMs)
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

    if (!(await waitForRequestSlot())) return null
    const profile = await provider.getProfile({ priority: 'background' })
    if (!shouldContinue()) return null
    messagesTotal = profile.messagesTotal
    // `users.getProfile` and the local store are both account-wide, so this
    // denominator includes Spam/Trash and the metadata already written by the
    // priority backfill stages. A page's `resultSizeEstimate` is deliberately
    // not used: Gmail can return small listing estimates such as 201 even deep
    // into a much larger mailbox.
    threadsTotal = profile.threadsTotal
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
        page = await provider.listThreadIds({ pageToken, priority: 'background' })
      } catch (error) {
        if (!pageToken || resetExpiredCursor || !isExpiredPageTokenError(error)) throw error
        pageToken = undefined
        resetExpiredCursor = true
        listedThreadsDone = 0
        startingListedThreadsDone = 0
        threadsIndexed = countIndexedThreads()
        threadsIndexedBySweep = 0
        indexingElapsedMs = 0
        checkpoint.run('lifetime', 0, threadsTotal ?? null, accountId)
        continue
      }
      if (!shouldContinue()) return null

      const pageStartCount = listedThreadsDone
      for (const threadId of page.threadIds) {
        if (!shouldContinue()) return null
        if (atCap()) return stopAtCap(pageToken, pageStartCount)
        if (exists.get(accountId, threadId)) {
          listedThreadsDone++
          continue
        }
        if (!(await waitForRequestSlot())) return null
        const indexingStartedAt = time.now()
        try {
          const thread = await provider.getThread(threadId, {
            format: 'metadata',
            priority: 'background'
          })
          if (!shouldContinue()) return null
          // Foreground history work may have indexed this thread while the
          // metadata request was in flight. Do not overwrite it or treat that
          // unrelated write as lifetime-sweep throughput.
          if (!exists.get(accountId, threadId)) {
            const persisted = persistThread(db, accountId, thread, {
              metadataOnly: true,
              inboxVisibility: 'hide'
            })
            if (persisted) {
              threadsIndexed++
              threadsIndexedBySweep++
              indexingElapsedMs += Math.max(0, time.now() - indexingStartedAt)
            }
          }
        } catch (error) {
          // A moving mailbox can drop a listed thread before its metadata fetch.
          if (!(error instanceof GmailApiError) || error.status !== 404) throw error
        }
        listedThreadsDone++
      }

      pageToken = page.nextPageToken
      // Once per page: foreground history work can add a thread while this
      // low-priority pass yields, so the reported coverage is the account's
      // real indexed count rather than this sweep's listing position — but the
      // count scans every stored thread id, so it must stay out of the yield
      // loop's 250 ms ticks.
      threadsIndexed = countIndexedThreads()
      checkpoint.run(
        pageToken ? `lifetime:${pageToken}` : 'done',
        listedThreadsDone,
        threadsTotal ?? null,
        accountId
      )
      progress('running')
      if (!pageToken) return { threadCount: listedThreadsDone, ...runMetrics() }

      progress('quota-wait', pagePauseMs)
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
  threadsIndexedBySweep: number,
  indexingElapsedMs: number
): number | undefined {
  if (
    threadsTotal === undefined ||
    threadsDone >= threadsTotal ||
    threadsIndexedBySweep <= 0 ||
    indexingElapsedMs <= 0
  ) {
    return undefined
  }
  return Math.ceil(((threadsTotal - threadsDone) * indexingElapsedMs) / threadsIndexedBySweep)
}
