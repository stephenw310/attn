// Ids-only lifetime pass that marks which stored threads carry an attachment
// (SPEC §9 #18c). Header-only rows — everything the all-mail stage and the
// lifetime sweep store — have no MIME part tree, so `threads.has_attachment`
// stays 0 until a thread is hydrated: no paperclip chip in the list and no
// local `has:attachment` match. Gmail can answer the question by search, and
// listing ids is roughly 1% of the sweep's cost because nothing is fetched
// per thread. Runs once, after the sweep, and then reports done forever: new
// mail arrives through full-format fetches that set the flag on the write path.

import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { type SchedulerTime, systemTime } from '../time'
import { LIFETIME_FOREGROUND_YIELD_MS, LIFETIME_PAGE_PAUSE_MS } from './lifetimeSweep'
import type { MailProvider, ThreadIdPage } from './provider'

/** The one Gmail operator this pass depends on. */
export const ATTACHMENT_FLAG_QUERY = 'has:attachment'

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

export type AttachmentFlagStartPlan = { kind: 'skip' } | { kind: 'run'; pageToken?: string }

const CURSOR_PHASE = 'attachments'

/** Same `phase` / `phase:pageToken` / `done` grammar as the sweep's own cursor. */
export function planAttachmentFlagStart(rawCursor: string | null | undefined): AttachmentFlagStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  if (!rawCursor || rawCursor === CURSOR_PHASE) return { kind: 'run' }
  if (rawCursor.startsWith(`${CURSOR_PHASE}:`) && rawCursor.length > CURSOR_PHASE.length + 1) {
    return { kind: 'run', pageToken: rawCursor.slice(CURSOR_PHASE.length + 1) }
  }
  throw new Error(`Invalid attachment flag cursor: ${rawCursor}`)
}

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
  const time = options.time ?? systemTime
  const shouldContinue = options.shouldContinue ?? (() => true)
  const shouldYield = options.shouldYield ?? (() => false)
  const pagePauseMs = options.pagePauseMs ?? LIFETIME_PAGE_PAUSE_MS
  const foregroundYieldMs = options.foregroundYieldMs ?? LIFETIME_FOREGROUND_YIELD_MS

  let threadsFlagged = 0
  const progress = (reason: AttachmentFlagProgress['reason'], mailChanged = false, waitMs?: number): void => {
    callbacks.onProgress({
      threadsFlagged,
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

  const waitForRequestSlot = async (): Promise<boolean> => {
    let yielded = false
    while (shouldContinue() && shouldYield()) {
      yielded = true
      progress('foreground-yield', false, foregroundYieldMs)
      if (!(await wait(foregroundYieldMs))) return false
    }
    if (!shouldContinue()) return false
    if (yielded) progress('running')
    return true
  }

  try {
    const state = db
      .prepare('SELECT attachment_cursor FROM sync_state WHERE account_id = ?')
      .get(accountId) as { attachment_cursor: string | null } | undefined
    const plan = planAttachmentFlagStart(state?.attachment_cursor)
    if (plan.kind === 'skip') return { threadsFlagged: 0 }

    const checkpoint = db.prepare('UPDATE sync_state SET attachment_cursor = ? WHERE account_id = ?')
    // Raise only, and only for threads the store already holds: this pass adds
    // no mail, and `changes` then counts real repaints rather than re-marks.
    const raise = db.prepare(
      `UPDATE threads SET has_attachment = 1
       WHERE account_id = ? AND id = ? AND has_attachment = 0`
    )
    let pageToken = plan.pageToken
    let resetExpiredCursor = false

    for (;;) {
      if (!(await waitForRequestSlot())) return null
      let page: ThreadIdPage
      try {
        page = await provider.listThreadIds({
          q: ATTACHMENT_FLAG_QUERY,
          pageToken,
          priority: 'background'
        })
      } catch (error) {
        if (!pageToken || resetExpiredCursor || !isExpiredPageToken(error)) throw error
        pageToken = undefined
        resetExpiredCursor = true
        threadsFlagged = 0
        checkpoint.run(CURSOR_PHASE, accountId)
        continue
      }
      if (!shouldContinue()) return null

      let flaggedOnPage = 0
      db.transaction(() => {
        for (const threadId of page.threadIds) flaggedOnPage += raise.run(accountId, threadId).changes
      })()
      threadsFlagged += flaggedOnPage

      pageToken = page.nextPageToken
      checkpoint.run(pageToken ? `${CURSOR_PHASE}:${pageToken}` : 'done', accountId)
      progress('running', flaggedOnPage > 0)
      if (!pageToken) return { threadsFlagged }

      progress('quota-wait', false, pagePauseMs)
      if (!(await wait(pagePauseMs))) return null
      progress('running')
    }
  } catch (error) {
    if (shouldContinue()) callbacks.onError(error)
    return null
  }
}

function isExpiredPageToken(error: unknown): boolean {
  return error instanceof GmailApiError && (error.status === 400 || error.status === 404)
}
