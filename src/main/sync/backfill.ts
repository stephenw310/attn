// Resumable staged backfill in priority order: 12 months of INBOX metadata,
// 90 days of full INBOX bodies, all Gmail drafts, 12 months of all-mail
// metadata (archived + sent + everything outside Spam/Trash), then Spam and
// Trash metadata (Gmail only retains ~30 days of each), then per-label
// membership reconciliation. Each completed page checkpoints the next
// phase/token. Overlapping stages skip threads already stored rather than
// carving date complements — Gmail's date operators have fuzzy boundaries and
// a seam gap loses mail silently, while re-listing ids is ~1% of fetch cost.

import type { SyncStage } from '../../shared/mail'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { reconcileRemoteDraft } from '../outbox/draftSync'
import { type SchedulerTime, systemTime } from '../time'
import { hydrateMissingThreadBodies } from './bodies'
import { isExpiredPageTokenError } from './pageToken'
import { ensureAccount, persistThread, upsertLabels } from './persist'
import type { DraftPage, ListThreadIdsOptions, MailProvider, ThreadIdPage } from './provider'
import { ALL_MAIL_WINDOW, INBOX_BODIES_WINDOW, INBOX_METADATA_WINDOW } from './windows'

export interface BackfillCallbacks {
  onProgress: (progress: BackfillProgress) => void
  onError: (error: unknown) => void
  onMetric?: (metric: BackfillMetric) => void
}

export interface BackfillProgress {
  stage: BackfillPhase
  threadsDone: number
  stageThreadsListed?: number
  stageThreadsFetched?: number
  stageThreadsEstimate?: number
  elapsedMs?: number
  stageElapsedMs?: number
  threadsPerMinute?: number
  stageListedPerMinute?: number
  stageFetchedPerMinute?: number
  quotaWaitMs?: number
  firstReadableMs?: number
  interactiveReadyMs?: number
  mailChanged: boolean
}

export type BackfillMetric =
  | {
      kind: 'stage-complete'
      stage: BackfillPhase
      threadsListed: number
      threadsFetched: number
      threadsEstimate?: number
      elapsedMs: number
      threadsPerMinute?: number
      quotaWaitMs: number
      firstReadableMs?: number
      interactiveReadyMs?: number
    }
  | {
      kind: 'complete'
      threadsDone: number
      elapsedMs: number
      quotaWaitMs: number
      firstReadableMs?: number
      interactiveReadyMs?: number
    }

export interface BackfillResult {
  threadCount: number
  /**
   * Authoritative per-label membership from the reconcile phase. Only meaningful for
   * a run that reached reconciliation — callers must check the plan for 'skip' first,
   * because reconciling against an empty list would strip the label from every thread.
   */
  inboxThreadIds: string[]
  spamThreadIds: string[]
  trashThreadIds: string[]
}

export interface BackfillOptions {
  /** Restart a completed backfill, but resume one already in progress. */
  recovery?: boolean
  time?: SchedulerTime
}

export type BackfillPhase = SyncStage

export interface ParsedCursor {
  phase: BackfillPhase
  pageToken?: string
}

export type BackfillStartPlan = { kind: 'skip' } | { kind: 'run'; cursor: ParsedCursor; initialize: boolean }

/** Pure routing for fresh, resumed, and completed databases. */
export function planBackfillStart(rawCursor: string | null | undefined, recovery = false): BackfillStartPlan {
  if (rawCursor === 'done' && !recovery) return { kind: 'skip' }
  const resuming = Boolean(rawCursor && rawCursor !== 'done')
  return {
    kind: 'run',
    cursor: resuming ? parseCursor(rawCursor) : { phase: 'metadata' },
    initialize: !resuming
  }
}

export async function runInboxBackfill(
  db: Db,
  provider: MailProvider,
  callbacks: BackfillCallbacks,
  options: BackfillOptions = {}
): Promise<BackfillResult | null> {
  const time = options.time ?? systemTime
  const startedAt = time.now()
  const quotaWaitStartedAt = provider.quotaMetrics?.().waitMs ?? 0
  let threadsDone = 0
  let stageStartedAt = startedAt
  let stageThreadsListed = 0
  let stageThreadsFetched = 0
  let stageThreadsEstimate: number | undefined
  let stageQuotaWaitStartedAt = 0
  let firstReadableMs: number | undefined
  let interactiveReadyMs: number | undefined

  const quotaWaitMs = (): number =>
    Math.max(0, (provider.quotaMetrics?.().waitMs ?? quotaWaitStartedAt) - quotaWaitStartedAt)
  const rate = (count: number, elapsedMs: number): number | undefined =>
    count > 0 && elapsedMs > 0 ? Math.round((count * 60_000) / elapsedMs) : undefined
  const emitProgress = (stage: BackfillPhase, mailChanged: boolean): void => {
    const now = time.now()
    const elapsedMs = Math.max(0, now - startedAt)
    const stageElapsedMs = Math.max(0, now - stageStartedAt)
    const threadsPerMinute = rate(threadsDone, elapsedMs)
    const stageListedPerMinute = rate(stageThreadsListed, stageElapsedMs)
    const stageFetchedPerMinute = rate(stageThreadsFetched, stageElapsedMs)
    callbacks.onProgress({
      stage,
      threadsDone,
      stageThreadsListed,
      stageThreadsFetched,
      ...(stageThreadsEstimate === undefined ? {} : { stageThreadsEstimate }),
      elapsedMs,
      stageElapsedMs,
      ...(threadsPerMinute === undefined ? {} : { threadsPerMinute }),
      ...(stageListedPerMinute === undefined ? {} : { stageListedPerMinute }),
      ...(stageFetchedPerMinute === undefined ? {} : { stageFetchedPerMinute }),
      quotaWaitMs: quotaWaitMs(),
      ...(firstReadableMs === undefined ? {} : { firstReadableMs }),
      ...(interactiveReadyMs === undefined ? {} : { interactiveReadyMs }),
      mailChanged
    })
  }
  const beginStage = (stage: BackfillPhase): void => {
    stageStartedAt = time.now()
    stageThreadsListed = 0
    stageThreadsFetched = 0
    stageThreadsEstimate = undefined
    stageQuotaWaitStartedAt = quotaWaitMs()
    emitProgress(stage, false)
  }
  const pageCompleted = (
    stage: BackfillPhase,
    page: { listed: number; fetched: number; estimate?: number },
    mailChanged = page.fetched > 0,
    cumulative = true
  ): void => {
    if (cumulative) threadsDone += page.fetched
    stageThreadsListed += page.listed
    stageThreadsFetched += page.fetched
    stageThreadsEstimate ??= page.estimate
    if (stage === 'metadata' && firstReadableMs === undefined && (page.fetched > 0 || page.estimate === 0)) {
      firstReadableMs = Math.max(0, time.now() - startedAt)
    }
    emitProgress(stage, mailChanged)
  }
  const completeStage = (stage: BackfillPhase): void => {
    const elapsedMs = Math.max(0, time.now() - stageStartedAt)
    const threadsPerMinute = rate(stageThreadsFetched, elapsedMs)
    callbacks.onMetric?.({
      kind: 'stage-complete',
      stage,
      threadsListed: stageThreadsListed,
      threadsFetched: stageThreadsFetched,
      ...(stageThreadsEstimate === undefined ? {} : { threadsEstimate: stageThreadsEstimate }),
      elapsedMs,
      ...(threadsPerMinute === undefined ? {} : { threadsPerMinute }),
      quotaWaitMs: Math.max(0, quotaWaitMs() - stageQuotaWaitStartedAt),
      ...(firstReadableMs === undefined ? {} : { firstReadableMs }),
      ...(interactiveReadyMs === undefined ? {} : { interactiveReadyMs })
    })
  }

  try {
    const profile = await provider.getProfile({ priority: 'foreground' })
    const accountId = profile.emailAddress
    ensureAccount(db, accountId, profile.emailAddress)

    const previous = db
      .prepare('SELECT backfill_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null } | undefined
    const plan = planBackfillStart(previous?.backfill_cursor, options.recovery)
    if (plan.kind === 'skip') {
      return { threadCount: 0, inboxThreadIds: [], spamThreadIds: [], trashThreadIds: [] }
    }

    let cursor = plan.cursor
    if (plan.initialize) {
      // Record the gapless history checkpoint before the first metadata page.
      db.prepare(
        `INSERT INTO sync_state (account_id, last_history_id, backfill_cursor)
         VALUES (?, ?, 'metadata')
         ON CONFLICT(account_id) DO UPDATE SET
           last_history_id = excluded.last_history_id,
           backfill_cursor = excluded.backfill_cursor`
      ).run(accountId, profile.historyId)
    }

    upsertLabels(db, accountId, await provider.listLabels({ priority: 'foreground' }))

    if (cursor.phase === 'metadata') {
      beginStage('metadata')
      await runThreadPhase({
        db,
        provider,
        accountId,
        query: INBOX_METADATA_WINDOW,
        labelIds: ['INBOX'],
        phase: 'metadata',
        initialPageToken: cursor.pageToken,
        nextPhase: 'bodies',
        priority: 'foreground',
        onThread: async (threadId) => {
          persistThread(
            db,
            accountId,
            await provider.getThread(threadId, { format: 'metadata', priority: 'foreground' }),
            {
              metadataOnly: true,
              inboxVisibility: 'show'
            }
          )
        },
        onPage: (page) => pageCompleted('metadata', page)
      })
      if (firstReadableMs === undefined) firstReadableMs = Math.max(0, time.now() - startedAt)
      interactiveReadyMs = Math.max(0, time.now() - startedAt)
      completeStage('metadata')
      cursor = { phase: 'bodies' }
    }

    if (cursor.phase === 'bodies') {
      beginStage('bodies')
      await runThreadPhase({
        db,
        provider,
        accountId,
        query: INBOX_BODIES_WINDOW,
        labelIds: ['INBOX'],
        phase: 'bodies',
        initialPageToken: cursor.pageToken,
        nextPhase: 'drafts',
        priority: 'background',
        onThread: async (threadId) => {
          const thread = await provider.getThread(threadId, { format: 'full', priority: 'background' })
          persistThread(db, accountId, thread, { inboxVisibility: 'show' })
          await hydrateMissingThreadBodies(db, provider, accountId, thread, undefined, {
            priority: 'background'
          })
        },
        onPage: (page) => pageCompleted('bodies', page)
      })
      completeStage('bodies')
      cursor = { phase: 'drafts' }
    }

    if (cursor.phase === 'drafts') {
      beginStage('drafts')
      await runDraftPhase({
        db,
        provider,
        accountId,
        initialPageToken: cursor.pageToken,
        now: time.now,
        onPage: (page) => pageCompleted('drafts', page)
      })
      completeStage('drafts')
      cursor = { phase: 'all-mail' }
    }

    if (cursor.phase === 'all-mail') {
      // No label filter: archived + sent + everything Gmail returns from its
      // default listing. Threads the INBOX stages already stored are skipped,
      // which is what keeps the deliberate 12-month overlap nearly free.
      beginStage('all-mail')
      await runThreadPhase({
        db,
        provider,
        accountId,
        query: ALL_MAIL_WINDOW,
        phase: 'all-mail',
        initialPageToken: cursor.pageToken,
        nextPhase: 'spam',
        skipExisting: true,
        priority: 'background',
        onThread: async (threadId) => {
          persistThread(
            db,
            accountId,
            await provider.getThread(threadId, { format: 'metadata', priority: 'background' }),
            {
              metadataOnly: true,
              inboxVisibility: 'show'
            }
          )
        },
        onPage: (page) => pageCompleted('all-mail', page)
      })
      completeStage('all-mail')
      cursor = { phase: 'spam' }
    }

    for (const junk of [
      { phase: 'spam', labelId: 'SPAM', nextPhase: 'trash' },
      { phase: 'trash', labelId: 'TRASH', nextPhase: 'reconcile' }
    ] as const) {
      if (cursor.phase !== junk.phase) continue
      // Gmail purges Spam and Trash at ~30 days, so "everything" is inherently
      // small here — no date bound needed.
      beginStage(junk.phase)
      await runThreadPhase({
        db,
        provider,
        accountId,
        labelIds: [junk.labelId],
        includeSpamTrash: true,
        phase: junk.phase,
        initialPageToken: cursor.pageToken,
        nextPhase: junk.nextPhase,
        skipExisting: true,
        priority: 'background',
        onThread: async (threadId) => {
          persistThread(
            db,
            accountId,
            await provider.getThread(threadId, { format: 'metadata', priority: 'background' }),
            { metadataOnly: true }
          )
        },
        onPage: (page) => pageCompleted(junk.phase, page)
      })
      completeStage(junk.phase)
      cursor = { phase: junk.nextPhase }
    }

    // Re-list ids per reconciled label for authoritative membership repair.
    // This remains metadata-free and prevents older local threads being
    // stripped. Spam/Trash listings double as the purge signal upstream:
    // locally-labeled threads missing from them get verified thread-by-thread.
    beginStage('reconcile')
    const reconcilePage = (listed: number): void =>
      pageCompleted('reconcile', { listed, fetched: 0 }, false, false)
    const inboxThreadIds = await listAllThreadIds(provider, { labelIds: ['INBOX'] }, reconcilePage)
    const spamThreadIds = await listAllThreadIds(
      provider,
      {
        labelIds: ['SPAM'],
        includeSpamTrash: true
      },
      reconcilePage
    )
    const trashThreadIds = await listAllThreadIds(
      provider,
      {
        labelIds: ['TRASH'],
        includeSpamTrash: true
      },
      reconcilePage
    )
    completeStage('reconcile')

    db.prepare('UPDATE sync_state SET backfill_cursor = ? WHERE account_id = ?').run('done', accountId)
    callbacks.onMetric?.({
      kind: 'complete',
      threadsDone,
      elapsedMs: Math.max(0, time.now() - startedAt),
      quotaWaitMs: quotaWaitMs(),
      ...(firstReadableMs === undefined ? {} : { firstReadableMs }),
      ...(interactiveReadyMs === undefined ? {} : { interactiveReadyMs })
    })
    return { threadCount: threadsDone, inboxThreadIds, spamThreadIds, trashThreadIds }
  } catch (error) {
    callbacks.onError(error)
    return null
  }
}

interface ThreadPhaseOptions {
  db: Db
  provider: MailProvider
  accountId: string
  query?: string
  labelIds?: readonly string[]
  includeSpamTrash?: boolean
  phase: Exclude<BackfillPhase, 'drafts' | 'reconcile'>
  initialPageToken?: string
  nextPhase: BackfillPhase
  priority: 'foreground' | 'background'
  /**
   * Skip listed ids already stored locally. Safe because the history checkpoint
   * predates the first backfill page, so the poller keeps stored threads
   * current — and it is what makes deliberately overlapping stages cheap.
   */
  skipExisting?: boolean
  onThread: (threadId: string) => Promise<void>
  onPage: (page: { listed: number; fetched: number; estimate?: number }) => void
}

async function runThreadPhase(options: ThreadPhaseOptions): Promise<void> {
  const exists = options.skipExisting
    ? options.db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?')
    : null
  let pageToken = options.initialPageToken
  let resetExpiredCursor = false
  for (;;) {
    let page: ThreadIdPage
    try {
      page = await options.provider.listThreadIds({
        ...(options.query === undefined ? {} : { q: options.query }),
        ...(options.labelIds === undefined ? {} : { labelIds: options.labelIds }),
        ...(options.includeSpamTrash ? { includeSpamTrash: true } : {}),
        pageToken,
        priority: options.priority
      })
    } catch (error) {
      if (!pageToken || resetExpiredCursor || !isExpiredPageTokenError(error)) throw error
      // Preserve the original history checkpoint while restarting this phase.
      pageToken = undefined
      resetExpiredCursor = true
      checkpoint(options.db, options.accountId, options.phase)
      continue
    }

    const wanted = exists
      ? page.threadIds.filter((threadId) => !exists.get(options.accountId, threadId))
      : page.threadIds
    let completed = 0
    await mapConcurrent(wanted, 3, async (threadId) => {
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
    if (page.threadIds.length > 0 || page.resultSizeEstimate !== undefined) {
      options.onPage({
        listed: page.threadIds.length,
        fetched: completed,
        ...(page.resultSizeEstimate === undefined ? {} : { estimate: page.resultSizeEstimate })
      })
    }
    pageToken = page.nextPageToken
    checkpoint(options.db, options.accountId, pageToken ? `${options.phase}:${pageToken}` : options.nextPhase)
    if (!pageToken) return
  }
}

interface DraftPhaseOptions {
  db: Db
  provider: MailProvider
  accountId: string
  initialPageToken?: string
  now: () => number
  onPage: (page: { listed: number; fetched: number }) => void
}

async function runDraftPhase(options: DraftPhaseOptions): Promise<void> {
  let pageToken = options.initialPageToken
  let resetExpiredCursor = false
  for (;;) {
    let page: DraftPage
    try {
      page = await options.provider.listDrafts(pageToken, { priority: 'background' })
    } catch (error) {
      if (!pageToken || resetExpiredCursor || !isExpiredPageTokenError(error)) throw error
      pageToken = undefined
      resetExpiredCursor = true
      checkpoint(options.db, options.accountId, 'drafts')
      continue
    }

    let completed = 0
    await mapConcurrent(page.drafts, 3, async (summary) => {
      try {
        await reconcileRemoteDraft(
          options.db,
          options.accountId,
          await options.provider.getDraft(summary.id, { priority: 'background' }),
          options.provider,
          options.now(),
          { priority: 'background' }
        )
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) return
        throw error
      }
      completed++
    })
    if (page.drafts.length > 0) options.onPage({ listed: page.drafts.length, fetched: completed })
    pageToken = page.nextPageToken
    checkpoint(options.db, options.accountId, pageToken ? `drafts:${pageToken}` : 'all-mail')
    if (!pageToken) return
  }
}

async function listAllThreadIds(
  provider: MailProvider,
  options: Pick<ListThreadIdsOptions, 'labelIds' | 'includeSpamTrash'>,
  onPage?: (count: number) => void
): Promise<string[]> {
  const threadIds = new Set<string>()
  let pageToken: string | undefined
  do {
    const page = await provider.listThreadIds({ ...options, pageToken, priority: 'background' })
    for (const threadId of page.threadIds) threadIds.add(threadId)
    if (page.threadIds.length > 0) onPage?.(page.threadIds.length)
    pageToken = page.nextPageToken
  } while (pageToken)
  return [...threadIds]
}

function parseCursor(raw: string | null | undefined): ParsedCursor {
  if (!raw || raw === 'metadata') return { phase: 'metadata' }
  if (raw === 'bodies') return { phase: 'bodies' }
  if (raw === 'drafts') return { phase: 'drafts' }
  if (raw === 'all-mail') return { phase: 'all-mail' }
  if (raw === 'spam') return { phase: 'spam' }
  if (raw === 'trash') return { phase: 'trash' }
  if (raw === 'reconcile') return { phase: 'reconcile' }
  if (raw.startsWith('metadata:')) return { phase: 'metadata', pageToken: raw.slice('metadata:'.length) }
  if (raw.startsWith('bodies:')) return { phase: 'bodies', pageToken: raw.slice('bodies:'.length) }
  if (raw.startsWith('drafts:')) return { phase: 'drafts', pageToken: raw.slice('drafts:'.length) }
  if (raw.startsWith('all-mail:')) return { phase: 'all-mail', pageToken: raw.slice('all-mail:'.length) }
  if (raw.startsWith('spam:')) return { phase: 'spam', pageToken: raw.slice('spam:'.length) }
  if (raw.startsWith('trash:')) return { phase: 'trash', pageToken: raw.slice('trash:'.length) }
  // The dedicated SENT stage retired when the unfiltered all-mail stage
  // subsumed it. A profile resuming mid-`sent` restarts at all-mail — the
  // stored page token belongs to a SENT-scoped listing and cannot continue an
  // unfiltered one, and skip-if-present makes the re-walk cheap.
  if (raw === 'sent' || raw.startsWith('sent:')) return { phase: 'all-mail' }
  throw new Error(`Invalid backfill cursor: ${raw}`)
}

function checkpoint(db: Db, accountId: string, cursor: string): void {
  db.prepare('UPDATE sync_state SET backfill_cursor = ? WHERE account_id = ?').run(cursor, accountId)
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
