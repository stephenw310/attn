// The smart-splits classifier pass: one account session's background walk of
// Inbox conversations that some described split has not answered for yet
// (SPEC F17 triage consent). It is a local-first worker in the utility
// process — it reads the store, asks TypeSafe about one thread at a time, and
// writes the answers back as `split_judgments` rows. Nothing it does depends
// on Gmail, and nothing it writes is mail content.
//
// The gate is re-read at the start of every pass and every batch: withdrawing
// consent, deleting the key, or removing the last described split stops the
// work at the next boundary rather than at the next restart.

import type { AiStoredSettings } from '../../shared/ai'
import { TYPESAFE_DEFAULT_MODEL } from '../../shared/ai'
import {
  judgeThread,
  TypeSafeAuthError,
  TypeSafeNetworkError,
  TypeSafeRateLimitError,
  TypeSafeRequestError,
  type TypeSafeTransport
} from '../ai/typesafeClient'
import type { Db } from '../db'
import {
  bumpSplitRevision,
  type DescribedSplitRule,
  describedSplitRules,
  pendingJudgmentPredicate,
  splitIdForThread,
  triageCandidateSql
} from '../splits'
import type { SchedulerTime } from '../time'
import { OfflineRetryScheduler } from './retry'
import {
  buildTriageQuestions,
  buildTriageState,
  type TriageMessageInput,
  type TriageQuestionTarget,
  type TriageThreadInput
} from './splitTriageState'
import {
  LIFETIME_FOREGROUND_YIELD_MS,
  SPLIT_TRIAGE_BATCH_SIZE,
  SPLIT_TRIAGE_BROADCAST_INTERVAL_MS,
  SPLIT_TRIAGE_CONCURRENCY,
  SPLIT_TRIAGE_OFFLINE_RETRY_MS,
  SPLIT_TRIAGE_RATE_LIMIT_BASE_MS,
  SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS,
  SPLIT_TRIAGE_RATE_LIMIT_MAX_WAIT_MS
} from './tuning'

export interface SplitTriageOptions {
  db: Db
  accountId: string
  time: SchedulerTime
  /** Resolved per request: the e2e seam installs its fake after construction. */
  transport: () => TypeSafeTransport
  readSettings: () => AiStoredSettings
  /** The memory-only relayed key, or null when the user stored none. */
  triageKey: () => string | null
  /** True while interactive work should get the next slot. */
  shouldYield?: () => boolean
  /** False once this account's session is gone; the pass stops at the boundary. */
  isActive: () => boolean
  /** Called after the split revision is bumped, at most once a second. */
  onAssignmentsChanged: () => void
  /** Threads judged after their `judgeNow` deadline passed. */
  onLateJudgment: (threadIds: string[]) => void
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
}

interface TriageGate {
  key: string
  model: string
  rules: DescribedSplitRule[]
}

interface WorkRow {
  threadId: string
  latestMessageId: string
}

interface PriorityRequest {
  pending: Set<string>
  judgedLate: string[]
  resolved: boolean
  resolve: () => void
}

interface MessageRow {
  from_name: string | null
  from_email: string | null
  snippet: string | null
  body_text: string | null
  labels_json: string | null
  recipients_json: string | null
}

function parseLabels(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string') : []
  } catch {
    return []
  }
}

/** How many people the message went to. The addresses themselves never travel. */
function parseRecipientCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return (['to', 'cc', 'bcc'] as const).reduce((sum, field) => {
      const list = parsed[field]
      return sum + (Array.isArray(list) ? list.length : 0)
    }, 0)
  } catch {
    return 0
  }
}

function messageInput(row: MessageRow): TriageMessageInput {
  return {
    fromName: row.from_name,
    fromEmail: row.from_email,
    snippet: row.snippet,
    bodyText: row.body_text,
    labels: parseLabels(row.labels_json),
    recipientCount: parseRecipientCount(row.recipients_json)
  }
}

const MESSAGE_COLUMNS = 'from_name, from_email, snippet, body_text, labels_json, recipients_json'

/**
 * Everything the state builder is given about one stored thread. Exported so
 * the dogfood eval (`scripts/triageEval.ts`) reads exactly the rows the pass
 * reads: a threshold measured on different evidence would not transfer.
 */
export function readTriageThread(db: Db, accountId: string, threadId: string): TriageThreadInput | null {
  const thread = db
    .prepare('SELECT subject FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, threadId) as { subject: string | null } | undefined
  if (!thread) return null
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS message_count,
              SUM(CASE WHEN list_id IS NOT NULL AND trim(list_id) <> '' THEN 1 ELSE 0 END) AS list_count
       FROM messages WHERE account_id = ? AND thread_id = ?`
    )
    .get(accountId, threadId) as { message_count: number; list_count: number | null }
  const first = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE account_id = ? AND thread_id = ?
       ORDER BY internal_date ASC, id ASC LIMIT 1`
    )
    .get(accountId, threadId) as MessageRow | undefined
  const latest = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE account_id = ? AND thread_id = ?
       ORDER BY internal_date DESC, id DESC LIMIT 1`
    )
    .get(accountId, threadId) as MessageRow | undefined
  if (!first || !latest) return null
  return {
    subject: thread.subject,
    messageCount: totals.message_count,
    mailingList: (totals.list_count ?? 0) > 0,
    first: messageInput(first),
    latest: messageInput(latest)
  }
}

export class SplitTriage {
  private readonly db: Db
  private readonly accountId: string
  private readonly time: SchedulerTime
  private readonly offlineRetry: OfflineRetryScheduler
  private abort = new AbortController()
  private stopped = false
  private pass: Promise<void> | null = null
  private rerun = false
  /** Threads whose request failed this pass; cleared when the next pass starts. */
  private readonly skipped = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly priorityThreads = new Set<string>()
  private readonly priority: PriorityRequest[] = []
  /**
   * The key the service refused. The gate stays closed for it, so a mail
   * change cannot spend a request per poll on a key already known bad; a
   * different key opens the gate again with no extra bookkeeping.
   */
  private authFailedKey: string | null = null
  private assignmentsChanged = false
  private lastBroadcastAt: number | null = null
  /** True only inside `onAssignmentsChanged`, so our own broadcast cannot re-kick us. */
  private broadcasting = false

  constructor(private readonly options: SplitTriageOptions) {
    this.db = options.db
    this.accountId = options.accountId
    this.time = options.time
    this.offlineRetry = new OfflineRetryScheduler(SPLIT_TRIAGE_OFFLINE_RETRY_MS, options.time)
  }

  /** Start a pass, or note that the running one should look again when it drains. */
  kick(): void {
    if (this.stopped || this.broadcasting) return
    // Cheapest possible closed gate: no key means no settings read at all,
    // which matters because every mail change calls this.
    if (this.options.triageKey() === null) return
    if (this.pass) {
      this.rerun = true
      return
    }
    this.rerun = false
    const pass = this.runPass()
      .catch((error) => this.log('error', `[triage] pass failed: ${describeError(error)}`))
      .finally(() => {
        if (this.pass === pass) this.pass = null
        if (this.rerun && !this.stopped) {
          this.rerun = false
          this.kick()
        }
      })
    this.pass = pass
  }

  /**
   * Whether a judgment can be asked for right now. The notification path needs
   * this answer synchronously: with the gate closed it must emit in the same
   * turn the mail arrived, exactly as it did before smart splits existed.
   */
  canJudge(): boolean {
    return this.gate() !== null
  }

  /** Resolves when no pass is running. The e2e seam awaits this. */
  async settled(): Promise<void> {
    while (this.pass) await this.pass
  }

  /** Cancel for shutdown or account teardown. Terminal: `kick` does nothing after it. */
  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.offlineRetry.clear()
    await this.settled()
    this.releasePriority()
  }

  /**
   * Judge these threads ahead of the queue and resolve when they are written
   * or `deadlineMs` passes. A missed deadline does not cancel the requests:
   * they finish, they are written, and `onLateJudgment` reports the ones that
   * landed too late for the notification decision that waited.
   */
  async judgeNow(threadIds: readonly string[], deadlineMs: number): Promise<void> {
    if (this.stopped || threadIds.length === 0) return
    if (!this.gate()) return
    const request: PriorityRequest = {
      pending: new Set(threadIds),
      judgedLate: [],
      resolved: false,
      resolve: () => {}
    }
    const settled = new Promise<void>((resolve) => {
      request.resolve = resolve
    })
    this.priority.push(request)
    for (const threadId of threadIds) this.priorityThreads.add(threadId)
    this.kick()
    const deadline = this.time.timers.setTimeout(() => {
      if (request.resolved) return
      request.resolved = true
      request.resolve()
    }, deadlineMs)
    try {
      await settled
    } finally {
      this.time.timers.clearTimeout(deadline)
    }
  }

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  private gate(): TriageGate | null {
    if (this.stopped || !this.options.isActive()) return null
    const key = this.options.triageKey()
    if (key === null || key === this.authFailedKey) return null
    const settings = this.options.readSettings()
    if (!settings.triageEnabled) return null
    const rules = describedSplitRules(this.db, this.accountId)
    if (rules.length === 0) return null
    return { key, model: settings.triageModel ?? TYPESAFE_DEFAULT_MODEL, rules }
  }

  private async runPass(): Promise<void> {
    this.skipped.clear()
    // Start the throttle window at the pass, not at the first change: a pass
    // that moves ten threads in a few milliseconds should bump the revision
    // once, when it is done, not once for the first thread and once at the end.
    this.lastBroadcastAt = this.time.now()
    for (;;) {
      const gate = this.gate()
      if (!gate) break
      const batch = this.nextBatch(gate)
      if (batch.length === 0) break
      if ((await this.judgeBatch(gate, batch)) === 'stop') break
    }
    this.flushAssignments()
    // A `judgeNow` that arrived while this pass was draining queued a rerun;
    // its callers wait for that pass rather than being released by this one.
    if (!this.rerun) this.releasePriority()
  }

  private nextBatch(gate: TriageGate): WorkRow[] {
    const rows: WorkRow[] = []
    const seen = new Set<string>()
    const waiting = [...this.priorityThreads]
      .filter((threadId) => !this.inFlight.has(threadId) && !this.skipped.has(threadId))
      .slice(0, SPLIT_TRIAGE_BATCH_SIZE)
    if (waiting.length > 0) {
      for (const row of this.selectWork(gate, waiting, SPLIT_TRIAGE_BATCH_SIZE)) {
        rows.push(row)
        seen.add(row.threadId)
      }
      // A waiting thread the query does not return needs no judgment — it is
      // already answered, or it left the Inbox. Release its caller now.
      for (const threadId of waiting) if (!seen.has(threadId)) this.settleThread(threadId, false)
    }
    if (rows.length >= SPLIT_TRIAGE_BATCH_SIZE) return rows
    for (const row of this.selectWork(gate, null, SPLIT_TRIAGE_BATCH_SIZE - rows.length)) {
      if (seen.has(row.threadId)) continue
      rows.push(row)
      seen.add(row.threadId)
    }
    return rows
  }

  /**
   * Inbox threads some described split has not answered for against the
   * thread's current latest message. The anti-join is per (split, hash, latest
   * message id), so editing a description or receiving a reply puts the thread
   * back in the queue without any explicit invalidation.
   */
  private selectWork(gate: TriageGate, threadIds: string[] | null, limit: number): WorkRow[] {
    if (limit <= 0) return []
    const excluded = threadIds
      ? []
      : [...new Set([...this.skipped, ...this.inFlight, ...this.priorityThreads])]
    const params: unknown[] = [this.accountId]
    const filters: string[] = []
    if (threadIds) {
      filters.push(`AND t.id IN (${threadIds.map(() => '?').join(', ')})`)
      params.push(...threadIds)
    }
    const unanswered = pendingJudgmentPredicate(this.accountId, gate.rules, {
      threadId: 'candidate.thread_id',
      evidenceKey: 'candidate.latest_message_id'
    })
    const exclusion =
      excluded.length > 0 ? `AND thread_id NOT IN (${excluded.map(() => '?').join(', ')})` : ''
    const rows = this.db
      .prepare(
        `WITH candidate AS (${triageCandidateSql(filters.join(' '))})
         SELECT thread_id, latest_message_id
         FROM candidate
         WHERE latest_message_id IS NOT NULL
           ${exclusion}
           AND (${unanswered.sql})
         ORDER BY sort_at DESC, thread_id DESC
         LIMIT ?`
      )
      .all(...params, ...excluded, ...unanswered.params, limit) as {
      thread_id: string
      latest_message_id: string
    }[]
    return rows.map((row) => ({ threadId: row.thread_id, latestMessageId: row.latest_message_id }))
  }

  /**
   * A thread some caller is waiting on, ahead of the queue. Checked inside the
   * batch loop rather than only between batches: an arrival that waits two
   * seconds cannot afford to sit behind a twenty-thread backlog.
   */
  private nextPriorityRow(gate: TriageGate): WorkRow | null {
    for (;;) {
      if (this.priorityThreads.size === 0) return null
      const threadId = [...this.priorityThreads].find((id) => !this.inFlight.has(id) && !this.skipped.has(id))
      if (!threadId) return null
      const [row] = this.selectWork(gate, [threadId], 1)
      if (row) return row
      // Already answered, or gone from the Inbox: release its caller and look
      // at the next one. `settleThread` drops it, so this terminates.
      this.settleThread(threadId, false)
    }
  }

  private async judgeBatch(gate: TriageGate, batch: WorkRow[]): Promise<'continue' | 'stop'> {
    const queue = [...batch]
    const handled = new Set<string>()
    const nextQueued = (): WorkRow | null => {
      for (;;) {
        const row = queue.shift()
        if (!row) return null
        if (handled.has(row.threadId) || this.inFlight.has(row.threadId)) continue
        return row
      }
    }
    let stop = false
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop || this.stopped || !this.options.isActive()) return
        const row = this.nextPriorityRow(gate) ?? nextQueued()
        if (!row) return
        handled.add(row.threadId)
        this.inFlight.add(row.threadId)
        try {
          await this.yieldToForeground()
          if (stop || this.stopped) return
          if ((await this.judgeOne(gate, row)) === 'stop') {
            stop = true
            return
          }
        } finally {
          this.inFlight.delete(row.threadId)
        }
      }
    }
    await Promise.all(Array.from({ length: SPLIT_TRIAGE_CONCURRENCY }, () => worker()))
    return stop ? 'stop' : 'continue'
  }

  private async judgeOne(gate: TriageGate, row: WorkRow): Promise<'ok' | 'stop'> {
    const thread = this.loadThread(row.threadId)
    if (!thread) {
      this.settleThread(row.threadId, false)
      return 'ok'
    }
    const state = buildTriageState(thread)
    const { questions, targets } = buildTriageQuestions(gate.rules)
    for (let attempt = 1; ; attempt++) {
      try {
        const probabilities = await judgeThread({
          key: gate.key,
          model: gate.model,
          state,
          questions,
          transport: this.options.transport(),
          time: this.time,
          signal: this.abort.signal
        })
        this.writeJudgments(row, targets, probabilities)
        this.settleThread(row.threadId, true)
        this.maybeBroadcast()
        return 'ok'
      } catch (error) {
        if (error instanceof TypeSafeAuthError) {
          this.authFailedKey = gate.key
          this.log('warn', `[triage] ${describeError(error)}; smart splits paused until the key changes`)
          this.settleThread(row.threadId, false)
          return 'stop'
        }
        if (error instanceof TypeSafeRateLimitError) {
          if (attempt >= SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS) {
            this.skipped.add(row.threadId)
            this.settleThread(row.threadId, false)
            return 'ok'
          }
          await this.wait(rateLimitWaitMs(error.retryAfterMs, attempt))
          if (this.stopped) {
            this.settleThread(row.threadId, false)
            return 'stop'
          }
          continue
        }
        if (error instanceof TypeSafeNetworkError) {
          this.settleThread(row.threadId, false)
          if (!this.stopped) {
            this.log('warn', `[triage] ${describeError(error)}; retrying later`)
            this.offlineRetry.schedule(
              () => !this.stopped,
              () => this.kick()
            )
          }
          return 'stop'
        }
        this.log('warn', `[triage] ${describeError(error)}; skipping one conversation`)
        this.skipped.add(row.threadId)
        this.settleThread(row.threadId, false)
        return 'ok'
      }
    }
  }

  // -------------------------------------------------------------------------
  // Store access
  // -------------------------------------------------------------------------

  private loadThread(threadId: string): TriageThreadInput | null {
    return readTriageThread(this.db, this.accountId, threadId)
  }

  private writeJudgments(
    row: WorkRow,
    targets: Record<string, TriageQuestionTarget>,
    probabilities: Record<string, number>
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO split_judgments
         (account_id, thread_id, split_id, description_hash, evidence_key, probability, judged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, thread_id, split_id) DO UPDATE SET
         description_hash = excluded.description_hash,
         evidence_key = excluded.evidence_key,
         probability = excluded.probability,
         judged_at = excluded.judged_at`
    )
    const judgedAt = this.time.now()
    const changed = this.db.transaction(() => {
      const before = splitIdForThread(this.db, this.accountId, row.threadId)
      for (const [questionId, target] of Object.entries(targets)) {
        const probability = probabilities[questionId]
        if (probability === undefined) continue
        upsert.run(
          this.accountId,
          row.threadId,
          target.splitId,
          target.descriptionHash,
          row.latestMessageId,
          probability,
          judgedAt
        )
      }
      return before !== splitIdForThread(this.db, this.accountId, row.threadId)
    })()
    if (changed) this.assignmentsChanged = true
  }

  // -------------------------------------------------------------------------
  // Broadcasting and waiting
  // -------------------------------------------------------------------------

  private maybeBroadcast(): void {
    if (!this.assignmentsChanged) return
    const now = this.time.now()
    if (this.lastBroadcastAt !== null && now - this.lastBroadcastAt < SPLIT_TRIAGE_BROADCAST_INTERVAL_MS) {
      return
    }
    this.flushAssignments()
  }

  private flushAssignments(): void {
    if (!this.assignmentsChanged) return
    this.assignmentsChanged = false
    this.lastBroadcastAt = this.time.now()
    // The renderer validates its cached Inbox pages against this revision, so
    // a moved thread that skips the bump is served from a stale page.
    bumpSplitRevision(this.db, this.accountId)
    this.broadcasting = true
    try {
      this.options.onAssignmentsChanged()
    } finally {
      this.broadcasting = false
    }
  }

  private settleThread(threadId: string, judged: boolean): void {
    this.priorityThreads.delete(threadId)
    for (const request of [...this.priority]) {
      if (!request.pending.delete(threadId)) continue
      if (judged && request.resolved) request.judgedLate.push(threadId)
      if (request.pending.size > 0) continue
      const index = this.priority.indexOf(request)
      if (index >= 0) this.priority.splice(index, 1)
      if (!request.resolved) {
        request.resolved = true
        request.resolve()
        continue
      }
      if (request.judgedLate.length > 0) this.options.onLateJudgment([...request.judgedLate])
    }
  }

  /** Nothing more will be judged for these callers now: let them proceed. */
  private releasePriority(): void {
    this.priorityThreads.clear()
    for (const request of this.priority.splice(0)) {
      if (request.resolved) continue
      request.resolved = true
      request.resolve()
    }
  }

  private async yieldToForeground(): Promise<void> {
    if (!this.options.shouldYield?.()) return
    await this.wait(LIFETIME_FOREGROUND_YIELD_MS)
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.time.timers.setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      const onAbort = (): void => {
        this.time.timers.clearTimeout(timer)
        resolve()
      }
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private log(level: 'log' | 'warn' | 'error', message: string): void {
    this.options.log?.(level, message)
  }
}

/** Honour Retry-After when it is sane, else the 1s/2s/4s ladder. */
function rateLimitWaitMs(retryAfterMs: number | null, attempt: number): number {
  const ladder = SPLIT_TRIAGE_RATE_LIMIT_BASE_MS * 2 ** (attempt - 1)
  const wait = retryAfterMs ?? ladder
  return Math.min(wait, SPLIT_TRIAGE_RATE_LIMIT_MAX_WAIT_MS)
}

/**
 * Only the client's own error classes carry a message safe to log: each one is
 * a fixed sentence plus an HTTP status. Any other failure stays anonymous, so
 * no provider or SQLite text can carry a request body into the log.
 */
function describeError(error: unknown): string {
  if (
    error instanceof TypeSafeAuthError ||
    error instanceof TypeSafeRateLimitError ||
    error instanceof TypeSafeRequestError ||
    error instanceof TypeSafeNetworkError
  ) {
    return error.message
  }
  return 'smart splits work failed'
}
