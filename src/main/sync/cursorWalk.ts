// The skeleton every resumable background pass shares: read a durable cursor,
// walk pages until the listing is exhausted, checkpoint each page only after
// its work is durable, yield the next request slot to foreground work, pace the
// pages, restart once when Gmail expires a page token, and report an error only
// while the pass is still wanted. Four runners had their own copy of all of it,
// down to the `phase` / `phase:token` / `done` cursor grammar, so it is tested
// once here and each runner keeps only its per-page body.

import type { Db } from '../db'
import { type SchedulerTime, systemTime } from '../time'
import { isExpiredPageTokenError } from './pageToken'
import { LIFETIME_FOREGROUND_YIELD_MS, LIFETIME_PAGE_PAUSE_MS } from './tuning'

export type CursorWalkReason = 'running' | 'quota-wait' | 'foreground-yield'

export interface CursorRunPlan {
  kind: 'run'
  token?: string
  initialize: boolean
}

export type CursorStartPlan = { kind: 'skip' } | CursorRunPlan

/** One `sync_state` row, limited to the columns a walk asked for. */
export type CursorWalkState = Record<string, unknown> | undefined

/**
 * The shared cursor grammar: an unset cursor or a bare `phase` starts from the
 * beginning, `phase:token` resumes at a durable listing position, and `done`
 * means the pass is finished for the life of the account.
 */
export function planCursorStart(
  phase: string,
  rawCursor: string | null | undefined,
  label: string
): CursorStartPlan {
  if (rawCursor === 'done') return { kind: 'skip' }
  if (!rawCursor || rawCursor === phase) return { kind: 'run', initialize: !rawCursor }
  if (rawCursor.startsWith(`${phase}:`) && rawCursor.length > phase.length + 1) {
    return { kind: 'run', token: rawCursor.slice(phase.length + 1), initialize: false }
  }
  throw new Error(`Invalid ${label} cursor: ${rawCursor}`)
}

/**
 * Pacing and cancellation, handed to every runner callback. Both awaiting calls
 * answer `false` only when the pass has been canceled, which is also when
 * `shouldContinue()` is false — so a callback may simply return early and let
 * the walk see the cancellation.
 */
export interface CursorWalkContext {
  /** Sleep, unless the delay is zero. */
  wait(delayMs: number): Promise<boolean>
  /** Yield to foreground work, then respect the request interval. */
  requestSlot(): Promise<boolean>
  shouldContinue(): boolean
  shouldYield(): boolean
}

/** A per-page or per-start body ends the whole walk by returning a result. */
export interface CursorWalkStop<Result> {
  stop: Result
}

export interface CursorWalk<Page, Result> {
  db: Db
  accountId: string
  /** The `sync_state` column holding this pass's cursor. */
  cursorColumn: string
  /** Cursor phase name, the prefix of a resumed cursor. */
  phase: string
  parseCursor: (rawCursor: string | null | undefined) => CursorStartPlan
  /** Extra `sync_state` columns to read with the cursor, for `onSkip`/`onStart`. */
  stateColumns?: readonly string[]
  time?: SchedulerTime
  /** Minimum spacing between requests. Zero paces on the page pause alone. */
  requestIntervalMs?: number
  pagePauseMs?: number
  foregroundYieldMs?: number
  /**
   * Reason reported around the between-pages pause, or `null` for a local pass
   * whose pause is not a quota wait and reports nothing.
   */
  pauseReason?: CursorWalkReason | null
  shouldYield?: () => boolean
  shouldContinue?: () => boolean
  /** Some passes reach accounts with no `sync_state` row yet. */
  ensureSyncStateRow?: boolean
  progress: (reason: CursorWalkReason, waitMs?: number) => void
  onError: (error: unknown) => void
  /** Result for a cursor that already says `done`. */
  onSkip: (state: CursorWalkState) => Result
  /** Runs once before the first page; may end the walk with a result. */
  onStart?: (
    plan: CursorRunPlan,
    context: CursorWalkContext,
    state: CursorWalkState
  ) => Promise<CursorWalkStop<Result> | void>
  listPage: (token: string | undefined, context: CursorWalkContext) => Promise<Page>
  nextToken: (page: Page) => string | undefined
  /** The page's own work, before its checkpoint. `token` fetched this page. */
  onPage: (
    page: Page,
    token: string | undefined,
    context: CursorWalkContext
  ) => Promise<CursorWalkStop<Result> | void>
  /** Resets per-run counters when an expired page token restarts the walk. */
  onRestart?: () => void
  /** Writes the cursor value; passes with extra checkpoint columns override it. */
  writeCursor?: (cursor: string) => void
  /** Wraps the page checkpoint, for a pass whose writes must commit with it. */
  commitPage?: (page: Page, applyCursor: () => void) => void
  /** Awaited after a durable checkpoint, before the walk decides to continue. */
  afterCheckpoint?: (cursor: string) => Promise<void> | void
  onFinish: () => Result
}

/** Run one resumable cursor walk. `null` means canceled or already reported. */
export async function runCursorWalk<Page, Result>(walk: CursorWalk<Page, Result>): Promise<Result | null> {
  const { accountId, db, phase, progress } = walk
  const time = walk.time ?? systemTime
  const shouldContinue = walk.shouldContinue ?? (() => true)
  const shouldYield = walk.shouldYield ?? (() => false)
  const requestIntervalMs = walk.requestIntervalMs ?? 0
  const pagePauseMs = walk.pagePauseMs ?? LIFETIME_PAGE_PAUSE_MS
  const foregroundYieldMs = walk.foregroundYieldMs ?? LIFETIME_FOREGROUND_YIELD_MS
  const pauseReason = walk.pauseReason === undefined ? 'quota-wait' : walk.pauseReason
  let lastRequestAt: number | null = null

  const wait = async (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) return shouldContinue()
    await new Promise<void>((resolve) => time.timers.setTimeout(resolve, delayMs))
    return shouldContinue()
  }

  const requestSlot = async (): Promise<boolean> => {
    let yielded = false
    while (shouldContinue() && shouldYield()) {
      yielded = true
      progress('foreground-yield', foregroundYieldMs)
      if (!(await wait(foregroundYieldMs))) return false
    }
    if (!shouldContinue()) return false
    if (yielded) progress('running')
    if (requestIntervalMs > 0 && lastRequestAt !== null) {
      const remaining = requestIntervalMs - (time.now() - lastRequestAt)
      if (remaining > 0 && !(await wait(remaining))) return false
    }
    lastRequestAt = time.now()
    return shouldContinue()
  }

  const context: CursorWalkContext = { wait, requestSlot, shouldContinue, shouldYield }

  try {
    if (walk.ensureSyncStateRow) {
      // Unit and upgrade scenarios can hold mail without a sync_state row; the
      // cursor UPDATE below must never be a silent no-op.
      db.prepare('INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)').run(accountId)
    }
    const columns = [walk.cursorColumn, ...(walk.stateColumns ?? [])].join(', ')
    const stored = db
      .prepare(`SELECT ${columns} FROM sync_state WHERE account_id = ?`)
      .get(accountId) as CursorWalkState
    const plan = walk.parseCursor(stored?.[walk.cursorColumn] as string | null | undefined)
    if (plan.kind === 'skip') return walk.onSkip(stored)

    const update = db.prepare(`UPDATE sync_state SET ${walk.cursorColumn} = ? WHERE account_id = ?`)
    const writeCursor = walk.writeCursor ?? ((cursor: string): void => void update.run(cursor, accountId))
    const commitPage = walk.commitPage ?? ((_page: Page, applyCursor: () => void): void => applyCursor())

    const started = await walk.onStart?.(plan, context, stored)
    if (!shouldContinue()) return null
    if (started) return started.stop

    let token = plan.token
    let restarted = false

    for (;;) {
      if (!(await requestSlot())) return null
      let page: Page
      try {
        page = await walk.listPage(token, context)
      } catch (error) {
        // Gmail expires a page token after about a week. Restart from the top
        // once; a second failure is a real error.
        if (!token || restarted || !isExpiredPageTokenError(error)) throw error
        token = undefined
        restarted = true
        walk.onRestart?.()
        writeCursor(phase)
        continue
      }
      if (!shouldContinue()) return null

      const outcome = await walk.onPage(page, token, context)
      if (!shouldContinue()) return null
      if (outcome) return outcome.stop

      token = walk.nextToken(page)
      const cursor = token ? `${phase}:${token}` : 'done'
      commitPage(page, () => writeCursor(cursor))
      progress('running')
      await walk.afterCheckpoint?.(cursor)
      if (!token) return walk.onFinish()

      if (pauseReason) progress(pauseReason, pagePauseMs)
      if (!(await wait(pagePauseMs))) return null
      if (pauseReason) progress('running')
    }
  } catch (error) {
    if (shouldContinue()) walk.onError(error)
    return null
  }
}

/**
 * Prepare a statement on first use. Runners build their statements this way so
 * a failure lands in the walk's error handling rather than rejecting the
 * promise a fire-and-forget caller never awaits.
 */
export function lazyStatement<T>(build: () => T): () => T {
  let statement: T | undefined
  return () => {
    statement ??= build()
    return statement
  }
}
