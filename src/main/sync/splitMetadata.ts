// One-time, resumable refresh of split-inbox metadata for profiles upgraded
// from a schema that did not store List-Id or calendar MIME-part flags. Fresh
// profiles default this cursor to done because the Inbox bodies stage already
// persists both fields from full payloads.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { SchedulerTime } from '../time'
import { type CursorWalkReason, lazyStatement, planCursorStart, runCursorWalk } from './cursorWalk'
import { persistThread } from './persist'
import type { MailProvider, ThreadIdPage } from './provider'
import { LIFETIME_REQUEST_INTERVAL_MS } from './tuning'

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
  const shouldYield = options.shouldYield ?? (() => false)
  const snapshotRevision = options.snapshotRevision ?? (() => 0)
  let threadsDone = 0
  let threadsRefreshed = 0
  let pageMailChanged = false

  // `mailChanged` belongs to the page just checkpointed, so the first report
  // after that page carries it and the reports around the pause do not.
  const progress = (reason: CursorWalkReason, waitMs?: number): void => {
    const mailChanged = pageMailChanged
    pageMailChanged = false
    callbacks.onProgress({
      threadsDone,
      reason,
      mailChanged,
      ...(waitMs === undefined ? {} : { waitMs })
    })
  }

  const storedInboxThread = lazyStatement(() =>
    db.prepare(
      `SELECT 1
       FROM threads t
       JOIN thread_labels inbox
         ON inbox.account_id = t.account_id AND inbox.thread_id = t.id AND inbox.label_id = 'INBOX'
       WHERE t.account_id = ? AND t.id = ? AND t.is_inbox_visible = 1`
    )
  )

  return runCursorWalk<ThreadIdPage, SplitMetadataResult>({
    db,
    accountId,
    cursorColumn: 'split_metadata_cursor',
    phase: CURSOR_PHASE,
    parseCursor: (cursor) => planCursorStart(CURSOR_PHASE, cursor, 'split metadata'),
    time: options.time,
    requestIntervalMs: options.requestIntervalMs ?? LIFETIME_REQUEST_INTERVAL_MS,
    pagePauseMs: options.pagePauseMs,
    foregroundYieldMs: options.foregroundYieldMs,
    shouldYield: options.shouldYield,
    shouldContinue: options.shouldContinue,
    progress,
    onError: callbacks.onError,
    onSkip: () => ({ threadsRefreshed: 0 }),
    listPage: (pageToken) =>
      provider.listThreadIds({ labelIds: ['INBOX'], pageToken, priority: 'background' }),
    nextToken: (page) => page.nextPageToken,
    onPage: async (page, _token, walk) => {
      let refreshedOnPage = 0
      for (const threadId of page.threadIds) {
        if (!walk.shouldContinue()) return
        if (!storedInboxThread().get(accountId, threadId)) {
          threadsDone += 1
          continue
        }
        if (!(await walk.requestSlot())) return
        try {
          for (;;) {
            const revisionBeforeFetch = snapshotRevision()
            const thread = await provider.getThread(threadId, {
              format: 'full',
              priority: 'background'
            })
            if (!walk.shouldContinue()) return
            // Do not let a response started before a history, action, or body
            // write overwrite the newer local snapshot. Wait for that work to
            // settle, then fetch this thread again before checkpointing it.
            if (shouldYield() || snapshotRevision() !== revisionBeforeFetch) {
              if (!(await walk.requestSlot())) return
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
      pageMailChanged = refreshedOnPage > 0
    },
    onRestart: () => {
      threadsDone = 0
      threadsRefreshed = 0
    },
    onFinish: () => ({ threadsRefreshed })
  })
}
