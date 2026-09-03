// Low-priority, resumable account-wide header indexing. The interactive backfill
// stays responsible for readiness; this walk only improves lifetime recall.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { type SchedulerTime, systemTime } from '../time'
import { type CursorWalkState, lazyStatement, planCursorStart, runCursorWalk } from './cursorWalk'
import { persistThread } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'
import { LIFETIME_REQUEST_INTERVAL_MS, LIFETIME_THREAD_CAP, LIFETIME_THREAD_CAP_UNLIMITED } from './tuning'

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

interface IndexedThreadCount {
  count: number
}

const CURSOR_PHASE = 'lifetime'

export function planLifetimeSweepStart(rawCursor: string | null | undefined): LifetimeSweepStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  // A capped walk retains the current page. Only an exhausted listing is done.
  const cursor = rawCursor?.startsWith('capped:') ? rawCursor.slice('capped:'.length) : rawCursor
  const plan = planCursorStart(CURSOR_PHASE, cursor, 'lifetime sweep')
  // `capped:done` is not a cursor the sweep writes, so it is not a stop either.
  if (plan.kind === 'skip') throw new Error(`Invalid lifetime sweep cursor: ${cursor}`)
  return {
    kind: 'run',
    ...(plan.token === undefined ? {} : { pageToken: plan.token }),
    initialize: plan.initialize
  }
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
  const threadCap = options.threadCap ?? LIFETIME_THREAD_CAP
  const startedAt = time.now()
  const quotaWaitStartedAt = provider.quotaMetrics?.().waitMs ?? 0
  const quotaWaitMs = (): number =>
    Math.max(0, (provider.quotaMetrics?.().waitMs ?? quotaWaitStartedAt) - quotaWaitStartedAt)

  // The durable count belongs to the listing cursor: it says how many ids the
  // sweep has walked, including rows that an earlier stage already stored.
  // User-visible progress has a different numerator — unique thread metadata
  // currently present in the local account store.
  let listedThreadsDone = 0
  let startingListedThreadsDone = 0
  let threadsIndexed = 0
  let threadsIndexedBySweep = 0
  let indexingElapsedMs = 0
  // The total is published from the Gmail profile on every run and never
  // stored: old builds saved `resultSizeEstimate` here, impossible values
  // included, and the sweep would have republished them.
  let threadsTotal: number | undefined
  let messagesTotal: number | undefined

  const checkpoint = lazyStatement(() =>
    db.prepare(
      `UPDATE sync_state
       SET sweep_cursor = ?, sweep_threads_done = ?
       WHERE account_id = ?`
    )
  )
  const indexedThreadCount = lazyStatement(() =>
    db.prepare('SELECT COUNT(*) AS count FROM threads WHERE account_id = ?')
  )
  const exists = lazyStatement(() => db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?'))

  const storedThreadsDone = (state: CursorWalkState): number => Number(state?.sweep_threads_done ?? 0)
  const countIndexedThreads = (): number => (indexedThreadCount().get(accountId) as IndexedThreadCount).count
  const writeCursor = (cursor: string): void => void checkpoint().run(cursor, listedThreadsDone, accountId)

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
    const etaMs = estimateRemainingMs(threadsIndexed, targetThreads, threadsIndexedBySweep, indexingElapsedMs)
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

  const atCap = (): boolean => threadCap !== LIFETIME_THREAD_CAP_UNLIMITED && threadsIndexed >= threadCap
  const stopAtCap = (pageToken: string | undefined, pageStartCount: number): LifetimeSweepResult => {
    // Replay the partial page on resume. Its starting count must accompany
    // the cursor, or already-stored ids on that page would be counted twice.
    const resumed = listedThreadsDone
    listedThreadsDone = pageStartCount
    writeCursor(`capped:${pageToken ? `${CURSOR_PHASE}:${pageToken}` : CURSOR_PHASE}`)
    listedThreadsDone = resumed
    console.log(`[sync] lifetime sweep stopped at the ${threadCap}-conversation limit for ${accountId}`)
    return { threadCount: listedThreadsDone, ...runMetrics() }
  }

  return runCursorWalk<ThreadIdPage, LifetimeSweepResult>({
    db,
    accountId,
    cursorColumn: 'sweep_cursor',
    phase: CURSOR_PHASE,
    parseCursor: (cursor) => {
      const plan = planLifetimeSweepStart(cursor)
      return plan.kind === 'skip' ? plan : { kind: 'run', token: plan.pageToken, initialize: plan.initialize }
    },
    time: options.time,
    requestIntervalMs: options.requestIntervalMs ?? LIFETIME_REQUEST_INTERVAL_MS,
    pagePauseMs: options.pagePauseMs,
    foregroundYieldMs: options.foregroundYieldMs,
    shouldYield: options.shouldYield,
    shouldContinue: options.shouldContinue,
    progress,
    onError: callbacks.onError,
    writeCursor,
    stateColumns: ['sweep_threads_done'],
    onSkip: (state) => ({ threadCount: storedThreadsDone(state), elapsedMs: 0, quotaWaitMs: 0 }),
    onStart: async (plan, walk, state) => {
      listedThreadsDone = plan.initialize ? 0 : storedThreadsDone(state)
      startingListedThreadsDone = listedThreadsDone
      if (plan.initialize) writeCursor(CURSOR_PHASE)
      threadsIndexed = countIndexedThreads()
      // An unchanged or lower cap needs no Gmail requests on the next launch.
      if (atCap()) return { stop: stopAtCap(plan.token, listedThreadsDone) }

      if (!(await walk.requestSlot())) return
      const profile = await provider.getProfile({ priority: 'background' })
      if (!walk.shouldContinue()) return
      messagesTotal = profile.messagesTotal
      // `users.getProfile` and the local store are both account-wide, so this
      // denominator includes Spam/Trash and the metadata already written by the
      // priority backfill stages. A page's `resultSizeEstimate` is deliberately
      // not used: Gmail can return small listing estimates such as 201 even deep
      // into a much larger mailbox.
      threadsTotal = profile.threadsTotal
      progress('running')
    },
    // Deliberately unfiltered: Gmail's default listing covers the whole account
    // except Spam and Trash, which are explicit stages of their own.
    listPage: (pageToken) => provider.listThreadIds({ pageToken, priority: 'background' }),
    nextToken: (page) => page.nextPageToken,
    onRestart: () => {
      listedThreadsDone = 0
      startingListedThreadsDone = 0
      threadsIndexed = countIndexedThreads()
      threadsIndexedBySweep = 0
      indexingElapsedMs = 0
    },
    onPage: async (page, pageToken, walk) => {
      const pageStartCount = listedThreadsDone
      for (const threadId of page.threadIds) {
        if (!walk.shouldContinue()) return
        if (atCap()) return { stop: stopAtCap(pageToken, pageStartCount) }
        if (exists().get(accountId, threadId)) {
          listedThreadsDone++
          continue
        }
        if (!(await walk.requestSlot())) return
        const indexingStartedAt = time.now()
        try {
          const thread = await provider.getThread(threadId, {
            format: 'metadata',
            priority: 'background'
          })
          if (!walk.shouldContinue()) return
          // Foreground history work may have indexed this thread while the
          // metadata request was in flight. Do not overwrite it or treat that
          // unrelated write as lifetime-sweep throughput.
          if (!exists().get(accountId, threadId)) {
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
    },
    // Once per page: foreground history work can add a thread while this
    // low-priority pass yields, so the reported coverage is the account's real
    // indexed count rather than this sweep's listing position — but the count
    // scans every stored thread id, so it must stay out of the yield loop's
    // 250 ms ticks.
    commitPage: (_page, applyCursor) => {
      threadsIndexed = countIndexedThreads()
      applyCursor()
    },
    onFinish: () => ({ threadCount: listedThreadsDone, ...runMetrics() })
  })
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
