// One-time, resumable refresh of split-inbox metadata for profiles upgraded
// from a schema that did not store List-Id or calendar MIME-part flags. Fresh
// profiles default this cursor to done because the Inbox bodies stage already
// persists both fields from full payloads.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { type SchedulerTime, systemTime } from '../time'
import { isExpiredPageTokenError } from './pageToken'
import { persistThread } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'
import { LIFETIME_FOREGROUND_YIELD_MS, LIFETIME_PAGE_PAUSE_MS, LIFETIME_REQUEST_INTERVAL_MS } from './tuning'

const CURSOR_PHASE = 'split-metadata'

export interface SplitMetadataProgress {
  threadsDone: number
  reason: 'running' | 'quota-wait' | 'foreground-yield'
  waitMs?: number
  mailChanged: boolean
}

export interface SplitMetadataCallbacks {
  onProgress: (progress: SplitMetadataProgress) => void
  onError: (error: unknown) => void
}

export interface SplitMetadataOptions {
  time?: SchedulerTime
  requestIntervalMs?: number
  pagePauseMs?: number
  foregroundYieldMs?: number
  shouldYield?: () => boolean
  shouldContinue?: () => boolean
  /** Changes whenever another authoritative or optimistic mail write is published. */
  snapshotRevision?: () => number
}

export interface SplitMetadataResult {
  threadsRefreshed: number
}

export type SplitMetadataStartPlan = { kind: 'skip' } | { kind: 'run'; pageToken?: string }

export function planSplitMetadataStart(rawCursor: string | null | undefined): SplitMetadataStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  if (!rawCursor || rawCursor === CURSOR_PHASE) return { kind: 'run' }
  if (rawCursor.startsWith(`${CURSOR_PHASE}:`) && rawCursor.length > CURSOR_PHASE.length + 1) {
    return { kind: 'run', pageToken: rawCursor.slice(CURSOR_PHASE.length + 1) }
  }
  throw new Error(`Invalid split metadata cursor: ${rawCursor}`)
}

/**
 * Re-fetch stored Inbox threads in full format and persist them through the
 * normal authoritative write path. Each Gmail listing page advances the
 * cursor only after every stored thread on that page has been refreshed.
 */
export async function runSplitMetadataRebuild(
  db: Db,
  provider: MailProvider,
  accountId: string,
  callbacks: SplitMetadataCallbacks,
  options: SplitMetadataOptions = {}
): Promise<SplitMetadataResult | null> {
  const time = options.time ?? systemTime
  const shouldContinue = options.shouldContinue ?? (() => true)
  const shouldYield = options.shouldYield ?? (() => false)
  const snapshotRevision = options.snapshotRevision ?? (() => 0)
  const requestIntervalMs = options.requestIntervalMs ?? LIFETIME_REQUEST_INTERVAL_MS
  const pagePauseMs = options.pagePauseMs ?? LIFETIME_PAGE_PAUSE_MS
  const foregroundYieldMs = options.foregroundYieldMs ?? LIFETIME_FOREGROUND_YIELD_MS
  let lastRequestAt: number | null = null
  let threadsDone = 0
  let threadsRefreshed = 0

  const progress = (reason: SplitMetadataProgress['reason'], mailChanged = false, waitMs?: number): void => {
    callbacks.onProgress({
      threadsDone,
      reason,
      mailChanged,
      ...(waitMs === undefined ? {} : { waitMs })
    })
  }

  const wait = async (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) return shouldContinue()
    await new Promise<void>((resolve) => time.timers.setTimeout(resolve, delayMs))
    return shouldContinue()
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

  try {
    const state = db
      .prepare('SELECT split_metadata_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { split_metadata_cursor: string | null } | undefined
    const plan = planSplitMetadataStart(state?.split_metadata_cursor)
    if (plan.kind === 'skip') return { threadsRefreshed: 0 }

    const checkpoint = db.prepare('UPDATE sync_state SET split_metadata_cursor = ? WHERE account_id = ?')
    const storedInboxThread = db.prepare(
      `SELECT 1
       FROM threads t
       JOIN thread_labels inbox
         ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
       WHERE t.account_id = ? AND t.id = ? AND t.is_inbox_visible = 1`
    )
    let pageToken = plan.pageToken
    let resetExpiredCursor = false

    for (;;) {
      if (!(await waitForRequestSlot())) return null
      let page: ThreadIdPage
      try {
        page = await provider.listThreadIds({
          labelIds: ['INBOX'],
          pageToken,
          priority: 'background'
        })
      } catch (error) {
        if (!pageToken || resetExpiredCursor || !isExpiredPageTokenError(error)) throw error
        pageToken = undefined
        resetExpiredCursor = true
        threadsDone = 0
        threadsRefreshed = 0
        checkpoint.run(CURSOR_PHASE, accountId)
        continue
      }
      if (!shouldContinue()) return null

      let refreshedOnPage = 0
      for (const threadId of page.threadIds) {
        if (!shouldContinue()) return null
        if (!storedInboxThread.get(accountId, threadId)) {
          threadsDone += 1
          continue
        }
        if (!(await waitForRequestSlot())) return null
        try {
          for (;;) {
            const revisionBeforeFetch = snapshotRevision()
            const thread = await provider.getThread(threadId, {
              format: 'full',
              priority: 'background'
            })
            if (!shouldContinue()) return null
            // Do not let a response started before a history, action, or body
            // write overwrite the newer local snapshot. Wait for that work to
            // settle, then fetch this thread again before checkpointing it.
            if (shouldYield() || snapshotRevision() !== revisionBeforeFetch) {
              if (!(await waitForRequestSlot())) return null
              continue
            }
            if (persistThread(db, accountId, thread, { inboxVisibility: 'preserve' })) {
              refreshedOnPage += 1
              threadsRefreshed += 1
            }
            break
          }
        } catch (error) {
          // A thread can leave Gmail after the page listing. History polling
          // owns deletion and membership reconciliation, so this pass skips it.
          if (!(error instanceof GmailApiError) || error.status !== 404) throw error
        }
        threadsDone += 1
      }

      pageToken = page.nextPageToken
      checkpoint.run(pageToken ? `${CURSOR_PHASE}:${pageToken}` : 'done', accountId)
      progress('running', refreshedOnPage > 0)
      if (!pageToken) return { threadsRefreshed }

      progress('quota-wait', false, pagePauseMs)
      if (!(await wait(pagePauseMs))) return null
      progress('running')
    }
  } catch (error) {
    if (shouldContinue()) callbacks.onError(error)
    return null
  }
}
