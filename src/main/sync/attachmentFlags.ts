// Ids-only lifetime pass that marks which stored threads carry an attachment
// (SPEC §9 #18c). Header-only rows — everything the all-mail stage and the
// lifetime sweep store — have no MIME part tree, so `threads.has_attachment`
// stays 0 until a thread is hydrated: no paperclip chip in the list and no
// local `has:attachment` match. Gmail can answer the question by search, and
// listing ids is roughly 1% of the sweep's cost because nothing is fetched
// per thread. Runs once, after the sweep, and then reports done forever: new
// mail arrives through full-format fetches that set the flag on the write path.

import type { Db } from '../db'
import type { SchedulerTime } from '../time'
import { type CursorWalkReason, lazyStatement, planCursorStart, runCursorWalk } from './cursorWalk'
import type { MailProvider, ThreadIdPage } from './provider'

/** The one Gmail operator this pass depends on. */
const ATTACHMENT_FLAG_QUERY = 'has:attachment'

export interface AttachmentFlagProgress {
  threadsFlagged: number
  reason: 'running' | 'quota-wait' | 'foreground-yield'
  waitMs?: number
  mailChanged: boolean
}

export interface AttachmentFlagCallbacks {
  onProgress: (progress: AttachmentFlagProgress) => void
  onError: (error: unknown) => void
}

export interface AttachmentFlagOptions {
  time?: SchedulerTime
  pagePauseMs?: number
  foregroundYieldMs?: number
  /** True while foreground Gmail work should get the next request slot. */
  shouldYield?: () => boolean
  /** Cancels future requests and, critically, all writes after an awaited request. */
  shouldContinue?: () => boolean
}

export interface AttachmentFlagResult {
  threadsFlagged: number
}

const CURSOR_PHASE = 'attachments'

/**
 * Walk `has:attachment` ids and raise the flag on threads already stored. The
 * flag is only ever raised: a thread whose attachment metadata is already known
 * stays known, and a thread this listing does not return is left alone rather
 * than being cleared, because absence here is not evidence (the listing
 * excludes Spam and Trash, and Gmail's operator is its own index).
 */
export async function runAttachmentFlagWalk(
  db: Db,
  provider: MailProvider,
  accountId: string,
  callbacks: AttachmentFlagCallbacks,
  options: AttachmentFlagOptions = {}
): Promise<AttachmentFlagResult | null> {
  let threadsFlagged = 0
  let pageMailChanged = false
  // `mailChanged` belongs to the page just checkpointed, so the first report
  // after that page carries it and the reports around the pause do not.
  const progress = (reason: CursorWalkReason, waitMs?: number): void => {
    const mailChanged = pageMailChanged
    pageMailChanged = false
    callbacks.onProgress({
      threadsFlagged,
      reason,
      ...(waitMs === undefined ? {} : { waitMs }),
      mailChanged
    })
  }
  // Raise only, and only for threads the store already holds: this pass adds
  // no mail, and `changes` then counts real repaints rather than re-marks.
  const raise = lazyStatement(() =>
    db.prepare(
      `UPDATE threads SET has_attachment = 1
       WHERE account_id = ? AND id = ? AND has_attachment = 0`
    )
  )

  return runCursorWalk<ThreadIdPage, AttachmentFlagResult>({
    db,
    accountId,
    cursorColumn: 'attachment_cursor',
    phase: CURSOR_PHASE,
    parseCursor: (cursor) => planCursorStart(CURSOR_PHASE, cursor, 'attachment flag'),
    time: options.time,
    pagePauseMs: options.pagePauseMs,
    foregroundYieldMs: options.foregroundYieldMs,
    shouldYield: options.shouldYield,
    shouldContinue: options.shouldContinue,
    progress,
    onError: callbacks.onError,
    onSkip: () => ({ threadsFlagged: 0 }),
    listPage: (pageToken) =>
      provider.listThreadIds({ q: ATTACHMENT_FLAG_QUERY, pageToken, priority: 'background' }),
    nextToken: (page) => page.nextPageToken,
    onPage: async (page) => {
      let flaggedOnPage = 0
      db.transaction(() => {
        for (const threadId of page.threadIds) flaggedOnPage += raise().run(accountId, threadId).changes
      })()
      threadsFlagged += flaggedOnPage
      pageMailChanged = flaggedOnPage > 0
    },
    onRestart: () => {
      threadsFlagged = 0
    },
    onFinish: () => ({ threadsFlagged })
  })
}
