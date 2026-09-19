// The smart-splits classifier pass: one account session's background walk of
// Inbox conversations that some described split has not answered for yet
// (SPEC F17 triage consent). It is a local-first worker in the utility
// process — it reads the store, asks TypeSafe about a pack of threads at a
// time, and writes the answers back as `split_judgments` rows. Nothing it does
// depends on Gmail, and nothing it writes is mail content.
//
// The gate is re-read at the start of every pass and every batch, and again
// after a rate-limit wait: withdrawing consent, deleting the key, changing the
// model, or editing a split's name or description stops the work at the next
// boundary rather than at the next restart.

import type { AiStoredSettings } from '../../shared/ai'
import { TYPESAFE_DEFAULT_MODEL } from '../../shared/ai'
import type { SplitTriageFailureCause } from '../../shared/splits'
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
  storedJudgmentHash,
  triageCandidateSql
} from '../splits'
import type { SchedulerTime, TimerHandle } from '../time'
import { OfflineRetryScheduler } from './retry'
import {
  buildPackedTriageRequest,
  buildTriageState,
  type TriageMessageInput,
  type TriageQuestionTarget,
  type TriageState,
  type TriageThreadInput
} from './splitTriageState'
import {
  LIFETIME_FOREGROUND_YIELD_MS,
  SPLIT_TRIAGE_BATCH_SIZE,
  SPLIT_TRIAGE_BROADCAST_INTERVAL_MS,
  SPLIT_TRIAGE_CONCURRENCY,
  SPLIT_TRIAGE_FAILURE_BACKOFF_MS,
  SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS,
  SPLIT_TRIAGE_MAX_ATTEMPTS,
  SPLIT_TRIAGE_OFFLINE_RETRY_MS,
  SPLIT_TRIAGE_PACK_SIZE,
  SPLIT_TRIAGE_RATE_LIMIT_BASE_MS,
  SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS,
  SPLIT_TRIAGE_RATE_LIMIT_MAX_WAIT_MS
} from './tuning'

/**
 * A judgment that landed after the wait it was asked for, and the message it
 * answered for. The notification path needs the message id: by the time the
 * answer arrives a newer arrival can own the conversation, and that arrival
 * has its own wait and its own decision.
 */
export interface LateJudgment {
  threadId: string
  messageId: string
}

/** What became of one conversation this pass claimed. See `settleThread`. */
type SettleOutcome = 'judged' | 'retry' | 'gone'

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
  onLateJudgment: (threads: LateJudgment[]) => void
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
}

interface TriageGate {
  key: string
  model: string
  rules: DescribedSplitRule[]
  /** The questions these rules ask: `splitId:descriptionHash` joined, in order. */
  rulesKey: string
}

interface WorkRow {
  threadId: string
  latestMessageId: string
}

/**
 * What one conversation has spent of its retry budget. The record outlives the
 * pass that made it: the defect it fixes was a pack dropped for the rest of the
 * session while the status counted its conversations as still pending.
 *
 * It names the inputs the failed attempt was judged against, so it stops
 * applying once a reply arrives or a description is edited. A record kept on
 * the thread id alone held a conversation out of the queue even after the
 * question, or the evidence to answer it with, had changed.
 */
interface FailureRecord {
  attempts: number
  nextAttemptAt: number
  cause: SplitTriageFailureCause
  /** The thread's latest message id when the attempt failed. */
  evidenceKey: string
  /** The described splits that attempt asked about. */
  rulesKey: string
}

interface PriorityRequest {
  pending: Set<string>
  /**
   * The latest message id each waiting thread held when the wait was made. The
   * caller asked about that arrival, so only a judgment of it answers the wait.
   */
  evidence: Map<string, string>
  judgedLate: LateJudgment[]
  resolved: boolean
  resolve: () => void
  /** When the wait was made, so a pass can drop one too old to notify for. */
  createdAt: number
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

/** The questions a gate asks, in rule order. A judgment answers exactly these. */
function rulesKeyOf(rules: readonly DescribedSplitRule[]): string {
  return rules.map((rule) => `${rule.splitId}:${rule.descriptionHash}`).join('|')
}

/**
 * Whether the consent captured before a wait is still the consent in force.
 * The rules compare by identity and question hash, in order: the hash covers
 * the name as well as the prose, so a rename reads as a changed question.
 */
function sameGate(captured: TriageGate, current: TriageGate): boolean {
  if (captured.key !== current.key || captured.model !== current.model) return false
  if (captured.rules.length !== current.rules.length) return false
  return captured.rules.every((rule, index) => {
    const other = current.rules[index]
    if (other === undefined || rule.splitId !== other.splitId) return false
    return rule.descriptionHash === other.descriptionHash
  })
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
  /** Threads whose request failed, and what they have left. Cleared on a judgment. */
  private readonly failures = new Map<string, FailureRecord>()
  /** The one timer that brings a backed-off thread back without a mail change. */
  private retryTimer: TimerHandle | null = null
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

  /**
   * Conversations that spent their attempt budget. They are no longer queued,
   * so the status reports them instead of counting them as pending forever.
   */
  failedThreadIds(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const { threadId, record } of this.applicableFailures()) {
      if (record.attempts >= SPLIT_TRIAGE_MAX_ATTEMPTS) ids.add(threadId)
    }
    return ids
  }

  /** The distinct causes behind those conversations, for the surface to name. */
  failedCauses(): SplitTriageFailureCause[] {
    const causes = new Set<SplitTriageFailureCause>()
    for (const { record } of this.applicableFailures()) {
      if (record.attempts >= SPLIT_TRIAGE_MAX_ATTEMPTS) causes.add(record.cause)
    }
    return [...causes].sort()
  }

  /** Forget every failure and ask again. The user's own retry. */
  retryFailed(): void {
    this.failures.clear()
    this.clearRetryTimer()
    this.kick()
  }

  /** Cancel for shutdown or account teardown. Terminal: `kick` does nothing after it. */
  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.offlineRetry.clear()
    this.clearRetryTimer()
    await this.settled()
    this.failures.clear()
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
    // The wait is for a judgment of the mail that prompted it. A pack claimed
    // before this arrival is already in flight against the message before it,
    // and its answer is not the one this caller asked for.
    const evidence = this.priorityEvidence(threadIds)
    // Nothing stored to judge: no message, or no longer an Inbox conversation.
    if (evidence.size === 0) return
    const request: PriorityRequest = {
      pending: new Set(evidence.keys()),
      evidence,
      judgedLate: [],
      resolved: false,
      resolve: () => {},
      createdAt: this.time.now()
    }
    const settled = new Promise<void>((resolve) => {
      request.resolve = resolve
    })
    this.priority.push(request)
    for (const threadId of evidence.keys()) this.priorityThreads.add(threadId)
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

  /**
   * The evidence each waiting thread is judged against: its latest message id,
   * read exactly the way the work query reads it, so the id a wait records is
   * the id the pack that judges it will store.
   */
  private priorityEvidence(threadIds: readonly string[]): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT thread_id, latest_message_id
         FROM (${triageCandidateSql('AND t.id IN (SELECT value FROM json_each(?))')})
         WHERE latest_message_id IS NOT NULL`
      )
      .all(this.accountId, JSON.stringify([...new Set(threadIds)])) as {
      thread_id: string
      latest_message_id: string
    }[]
    return new Map(rows.map((row) => [row.thread_id, row.latest_message_id]))
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
    const model = settings.triageModel ?? TYPESAFE_DEFAULT_MODEL
    return { key, model, rules, rulesKey: rulesKeyOf(rules) }
  }

  /**
   * Whether the consent a pack was claimed under still holds. The gate is read
   * again after every wait: withdrawing consent, replacing the key, changing
   * the model or editing a description while a request sleeps on a rate limit
   * must stop the retry rather than send the captured request.
   */
  private gateUnchanged(gate: TriageGate): boolean {
    const current = this.gate()
    return current !== null && sameGate(gate, current)
  }

  private async runPass(): Promise<void> {
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
    this.scheduleFailureRetry()
    // A pass can end on a failure somebody retries — a dropped connection, an
    // exhausted rate-limit ladder. Releasing every wait here would hand the
    // retry a judgment nobody is waiting for, so only the waits too old to
    // notify for are dropped.
    this.expirePriority()
  }

  /**
   * The pass stops at a thread whose backoff has not elapsed, so without this
   * nothing would look again until the next mail change. One timer, at the
   * earliest deadline: the pass it starts re-reads every record anyway.
   */
  private scheduleFailureRetry(): void {
    this.clearRetryTimer()
    if (this.stopped) return
    const now = this.time.now()
    let earliest: number | null = null
    for (const record of this.failures.values()) {
      if (record.attempts >= SPLIT_TRIAGE_MAX_ATTEMPTS || record.nextAttemptAt <= now) continue
      if (earliest === null || record.nextAttemptAt < earliest) earliest = record.nextAttemptAt
    }
    if (earliest === null) return
    this.retryTimer = this.time.timers.setTimeout(() => {
      this.retryTimer = null
      this.kick()
    }, earliest - now)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return
    this.time.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Whether this record still holds its conversation out of the queue. */
  private stillBlocking(record: FailureRecord, now: number): boolean {
    return record.attempts >= SPLIT_TRIAGE_MAX_ATTEMPTS || record.nextAttemptAt > now
  }

  /**
   * True while this thread is out of the queue: backing off, or given up on.
   * A record answers for the evidence and the questions it was made against,
   * so a reply or an edited description puts the conversation straight back.
   */
  private isBlocked(gate: TriageGate, row: WorkRow): boolean {
    const record = this.failures.get(row.threadId)
    if (!record) return false
    if (record.rulesKey !== gate.rulesKey || record.evidenceKey !== row.latestMessageId) return false
    return this.stillBlocking(record, this.time.now())
  }

  /** Every record still asking the current questions. The rest are forgotten. */
  private liveFailures(rulesKey: string): { threadId: string; record: FailureRecord }[] {
    const live: { threadId: string; record: FailureRecord }[] = []
    for (const [threadId, record] of [...this.failures]) {
      if (record.rulesKey === rulesKey) live.push({ threadId, record })
      else this.failures.delete(threadId)
    }
    return live
  }

  /**
   * The records that still describe work nobody is doing: the same questions,
   * against the same latest message the failed attempt read. The status calls
   * these conversations failed, so a record whose inputs changed must not
   * appear — the next pass judges that conversation without a user retry.
   */
  private applicableFailures(): { threadId: string; record: FailureRecord }[] {
    const live = this.liveFailures(rulesKeyOf(describedSplitRules(this.db, this.accountId)))
    if (live.length === 0) return []
    // One query for every id: mail arrives between passes, so the evidence a
    // record names is checked against the store rather than assumed current.
    const rows = this.db
      .prepare(
        `SELECT thread_id, latest_message_id
         FROM (${triageCandidateSql('AND t.id IN (SELECT value FROM json_each(?))')})`
      )
      .all(this.accountId, JSON.stringify(live.map(({ threadId }) => threadId))) as {
      thread_id: string
      latest_message_id: string | null
    }[]
    const latest = new Map(rows.map((row) => [row.thread_id, row.latest_message_id]))
    return live.filter(({ threadId, record }) => latest.get(threadId) === record.evidenceKey)
  }

  /**
   * Charge one attempt to this conversation and put it back after its backoff.
   * Past the budget it leaves the queue for good, and the status says so. The
   * budget belongs to the attempt's inputs, not to the thread id: a new message
   * or an edited description starts the ladder again from one.
   */
  private recordFailure(gate: TriageGate, row: WorkRow, cause: SplitTriageFailureCause): void {
    const previous = this.failures.get(row.threadId)
    const spent =
      previous && previous.rulesKey === gate.rulesKey && previous.evidenceKey === row.latestMessageId
        ? previous.attempts
        : 0
    const attempts = spent + 1
    const step = Math.min(attempts, SPLIT_TRIAGE_FAILURE_BACKOFF_MS.length) - 1
    const backoff = SPLIT_TRIAGE_FAILURE_BACKOFF_MS[step] ?? 0
    this.failures.set(row.threadId, {
      attempts,
      cause,
      nextAttemptAt: this.time.now() + backoff,
      evidenceKey: row.latestMessageId,
      rulesKey: gate.rulesKey
    })
    if (attempts === SPLIT_TRIAGE_MAX_ATTEMPTS) {
      this.log('warn', `[triage] gave up on conversation ${row.threadId} after ${attempts} attempts`)
    }
  }

  private nextBatch(gate: TriageGate): WorkRow[] {
    const rows: WorkRow[] = []
    const seen = new Set<string>()
    const waiting = [...this.priorityThreads]
      .filter((threadId) => !this.inFlight.has(threadId))
      .slice(0, SPLIT_TRIAGE_BATCH_SIZE)
    if (waiting.length > 0) {
      for (const row of this.selectWork(gate, waiting, SPLIT_TRIAGE_BATCH_SIZE)) {
        seen.add(row.threadId)
        // A blocked thread stays in `priorityThreads`, so the backlog query
        // below leaves it alone too; its timer, not this batch, brings it back.
        if (this.isBlocked(gate, row)) continue
        rows.push(row)
      }
      // A waiting thread the query does not return needs no judgment — it is
      // already answered, or it left the Inbox. Release its caller now.
      for (const threadId of waiting) if (!seen.has(threadId)) this.settleThread(threadId, 'gone')
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
    // A whole Inbox can be backing off at once, so each exclusion travels as
    // one JSON parameter rather than one bound id per thread.
    const busy = threadIds ? [] : [...new Set([...this.inFlight, ...this.priorityThreads])]
    // A failure names the evidence it answered for, so it takes the thread out
    // of the queue only while that message is still the latest one.
    const now = this.time.now()
    const backingOff = threadIds
      ? []
      : this.liveFailures(gate.rulesKey)
          .filter(({ record }) => this.stillBlocking(record, now))
          .map(({ threadId, record }) => ({ t: threadId, e: record.evidenceKey }))
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
    const busyFilter = busy.length > 0 ? 'AND thread_id NOT IN (SELECT value FROM json_each(?))' : ''
    const backoffFilter =
      backingOff.length > 0
        ? `AND NOT EXISTS (
             SELECT 1 FROM json_each(?) blocked
             WHERE json_extract(blocked.value, '$.t') = thread_id
               AND json_extract(blocked.value, '$.e') = latest_message_id
           )`
        : ''
    const exclusionParams = [
      ...(busy.length > 0 ? [JSON.stringify(busy)] : []),
      ...(backingOff.length > 0 ? [JSON.stringify(backingOff)] : [])
    ]
    const rows = this.db
      .prepare(
        `WITH candidate AS (${triageCandidateSql(filters.join(' '))})
         SELECT thread_id, latest_message_id
         FROM candidate
         WHERE latest_message_id IS NOT NULL
           ${busyFilter}
           ${backoffFilter}
           AND (${unanswered.sql})
         ORDER BY sort_at DESC, thread_id DESC
         LIMIT ?`
      )
      .all(...params, ...exclusionParams, ...unanswered.params, limit) as {
      thread_id: string
      latest_message_id: string
    }[]
    return rows.map((row) => ({ threadId: row.thread_id, latestMessageId: row.latest_message_id }))
  }

  /**
   * A thread some caller is waiting on, ahead of the queue. Taken first when a
   * pack is filled rather than only between batches: an arrival that waits two
   * seconds cannot afford to sit behind a forty-thread backlog.
   */
  private nextPriorityRow(gate: TriageGate, handled: ReadonlySet<string>): WorkRow | null {
    // Whether a thread is blocked depends on the evidence the query returns, so
    // a blocked one is passed over here rather than filtered out in advance.
    const skipped = new Set<string>()
    for (;;) {
      const threadId = [...this.priorityThreads].find(
        // One request per conversation per batch. A thread the batch already
        // asked about and could not settle waits for the next batch, which
        // re-reads the gate: without this a thread settled `'retry'` would be
        // claimed again in the same loop, against the same stale gate.
        (id) => !this.inFlight.has(id) && !handled.has(id) && !skipped.has(id)
      )
      if (!threadId) return null
      const [row] = this.selectWork(gate, [threadId], 1)
      if (!row) {
        // Already answered, or gone from the Inbox: release its caller and look
        // at the next one. `settleThread` drops it, so this terminates.
        this.settleThread(threadId, 'gone')
        continue
      }
      if (!this.isBlocked(gate, row)) return row
      skipped.add(threadId)
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
    // One request carries a pack, and a waiting thread fills it first, so an
    // arrival rides the next request rather than the next batch. The whole
    // pack is claimed before the first await, so two workers never share a row.
    const nextPack = (): WorkRow[] => {
      const pack: WorkRow[] = []
      while (pack.length < SPLIT_TRIAGE_PACK_SIZE) {
        const row = this.nextPriorityRow(gate, handled) ?? nextQueued()
        if (!row) break
        handled.add(row.threadId)
        this.inFlight.add(row.threadId)
        pack.push(row)
      }
      return pack
    }
    let stop = false
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop || this.stopped || !this.options.isActive()) return
        const pack = nextPack()
        if (pack.length === 0) return
        try {
          await this.yieldToForeground()
          if (stop || this.stopped) return
          if ((await this.judgePack(gate, pack)) === 'stop') {
            stop = true
            return
          }
        } finally {
          for (const row of pack) this.inFlight.delete(row.threadId)
        }
      }
    }
    await Promise.all(Array.from({ length: SPLIT_TRIAGE_CONCURRENCY }, () => worker()))
    return stop ? 'stop' : 'continue'
  }

  private async judgePack(gate: TriageGate, pack: WorkRow[]): Promise<'ok' | 'stop'> {
    // A thread that no longer loads is settled here and leaves the pack, so
    // `threadIndex` always indexes `loaded` rather than the rows we started with.
    const loaded: { row: WorkRow; state: TriageState }[] = []
    for (const row of pack) {
      const thread = this.loadThread(row.threadId)
      if (!thread) {
        this.settleThread(row.threadId, 'gone')
        continue
      }
      loaded.push({ row, state: buildTriageState(thread) })
    }
    if (loaded.length === 0) return 'ok'
    const settleAll = (outcome: SettleOutcome): void => {
      for (const entry of loaded) this.settleThread(entry.row.threadId, outcome)
    }
    const chargeAll = (cause: SplitTriageFailureCause): void => {
      for (const entry of loaded) this.recordFailure(gate, entry.row, cause)
    }
    const { state, questions, targets } = buildPackedTriageRequest(
      loaded.map((entry) => entry.state),
      gate.rules
    )
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
        loaded.forEach((entry, threadIndex) => {
          const { skipped } = this.writeJudgments(entry.row, threadIndex, targets, probabilities)
          // A skipped target is a question the pack answered and the user has
          // since changed. The conversation is still pending under the rules in
          // force, so its wait outlives this answer and the next pass re-asks.
          const outcome = skipped === 0 ? 'judged' : 'retry'
          this.settleThread(entry.row.threadId, outcome, entry.row.latestMessageId)
        })
        this.maybeBroadcast()
        return 'ok'
      } catch (error) {
        if (error instanceof TypeSafeAuthError) {
          this.authFailedKey = gate.key
          this.log('warn', `[triage] ${describeError(error)}; smart splits paused until the key changes`)
          // Nothing retries this pack: the gate stays closed until the key
          // changes, so holding the waits open would hold them for good.
          settleAll('gone')
          return 'stop'
        }
        if (error instanceof TypeSafeRateLimitError) {
          if (attempt >= SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS) {
            const count = `${loaded.length} conversation${loaded.length === 1 ? '' : 's'}`
            this.log('warn', `[triage] ${describeError(error)}; ${count} wait for a later pass`)
            chargeAll('rate-limited')
            // The backoff timer brings this pack back, so the waits stay with
            // their conversations and the retry can still report them late.
            settleAll('retry')
            return 'ok'
          }
          await this.wait(rateLimitWaitMs(error.retryAfterMs, attempt))
          // Consent, the key, the model and the descriptions can all change
          // while we sleep. The captured gate is no authority to ask again, so
          // the pack goes back unjudged and uncharged.
          if (!this.gateUnchanged(gate)) {
            settleAll('retry')
            return 'stop'
          }
          continue
        }
        if (error instanceof TypeSafeNetworkError) {
          // The offline scheduler below asks again, so the waits keep their
          // claim: a move into a split that notifies is still worth reporting.
          settleAll('retry')
          if (!this.stopped) {
            this.log('warn', `[triage] ${describeError(error)}; retrying later`)
            this.offlineRetry.schedule(
              () => !this.stopped,
              () => this.kick()
            )
          }
          return 'stop'
        }
        const count = `${loaded.length} conversation${loaded.length === 1 ? '' : 's'}`
        // A rejected pack is usually one bad conversation, not ten. Ask again
        // one conversation at a time, in this worker: the other nine are judged
        // in the same pass, and only a conversation that fails alone is charged.
        if (error instanceof TypeSafeRequestError && loaded.length > 1) {
          this.log('warn', `[triage] ${describeError(error)}; retrying ${count} one at a time`)
          for (const [index, entry] of loaded.entries()) {
            // Every singleton is a fresh request, so each one asks again
            // whether the consent that filled this pack still holds.
            const halted = !this.gateUnchanged(gate)
            if (halted || (await this.judgePack(gate, [entry.row])) === 'stop') {
              // The singleton settled its own row. The ones never tried had no
              // answer refused, so they keep their place and their waits.
              for (const rest of loaded.slice(halted ? index : index + 1)) {
                this.settleThread(rest.row.threadId, 'retry')
              }
              return 'stop'
            }
          }
          return 'ok'
        }
        this.log('warn', `[triage] ${describeError(error)}; skipping ${count}`)
        chargeAll('rejected')
        // The service refused this conversation on its own, so no retry in
        // this pass or the next few answers the question. Release the waits.
        settleAll('gone')
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

  /**
   * One thread's answers out of the pack's, in their own transaction.
   *
   * The pack was claimed before the request went out, so the split it answers
   * for can have been deleted, renamed or reworded, and the conversation can
   * have been deleted, while it was in flight. Each row is written only while
   * its split still asks that exact question and the thread still exists;
   * anything else is dropped rather than stored as an orphan.
   *
   * The counts say what the pack actually answered. A skipped target leaves
   * the conversation pending under the rules in force, so the caller settles
   * it for a retry rather than calling it judged.
   */
  private writeJudgments(
    row: WorkRow,
    threadIndex: number,
    targets: Record<string, TriageQuestionTarget>,
    probabilities: Record<string, number>
  ): { written: number; skipped: number } {
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
    const threadRow = this.db.prepare('SELECT 1 AS present FROM threads WHERE account_id = ? AND id = ?')
    const judgedAt = this.time.now()
    const mine = Object.entries(targets).filter(([, target]) => target.threadIndex === threadIndex)
    let written = 0
    let skipped = 0
    const changed = this.db.transaction(() => {
      written = 0
      skipped = 0
      // A conversation Gmail removed leaves nothing pending either: counting
      // its targets as skipped would queue a retry for a thread that is gone.
      if (!threadRow.get(this.accountId, row.threadId)) return false
      const before = splitIdForThread(this.db, this.accountId, row.threadId)
      for (const [questionId, target] of mine) {
        const stored = storedJudgmentHash(this.db, this.accountId, target.splitId)
        // A deleted split withdrew its question rather than changing it, so it
        // asks nothing the next pass has to answer.
        if (stored === null) continue
        const probability = probabilities[questionId]
        if (probability === undefined || stored !== target.descriptionHash) {
          skipped++
          continue
        }
        upsert.run(
          this.accountId,
          row.threadId,
          target.splitId,
          target.descriptionHash,
          row.latestMessageId,
          probability,
          judgedAt
        )
        written++
      }
      return before !== splitIdForThread(this.db, this.accountId, row.threadId)
    })()
    if (changed) this.assignmentsChanged = true
    return { written, skipped }
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

  /**
   * What became of one conversation this pass claimed.
   *
   * `'judged'` carries in `evidenceKey` the latest message the judgment read.
   * A wait registered for a newer message stays pending, so the answer to the
   * message before it cannot release the caller. That thread also stays in
   * `priorityThreads` — it is still pending in the anti-join, so the next pack
   * picks it up and answers the question actually asked.
   *
   * `'retry'` is a failure somebody asks again about: a dropped connection, an
   * exhausted rate-limit ladder, a gate withdrawn mid-pack, an answer the user
   * has since changed the question for. The conversation keeps its place in the
   * queue and in every wait, so the retry that judges it still reports it late.
   *
   * `'gone'` is an answer nobody is bringing: the conversation left the Inbox,
   * it is already judged, or the service refused it. Every wait is released.
   */
  private settleThread(threadId: string, outcome: SettleOutcome, evidenceKey?: string): void {
    if (outcome === 'retry') return
    // An answer spends the budget back: the next failure starts the ladder again.
    if (outcome === 'judged') this.failures.delete(threadId)
    let stillWaiting = false
    for (const request of [...this.priority]) {
      if (!request.pending.has(threadId)) continue
      const waited = request.evidence.get(threadId)
      if (outcome === 'judged' && waited !== evidenceKey) {
        stillWaiting = true
        continue
      }
      request.pending.delete(threadId)
      if (outcome === 'judged' && request.resolved && waited !== undefined) {
        request.judgedLate.push({ threadId, messageId: waited })
      }
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
    if (!stillWaiting) this.priorityThreads.delete(threadId)
  }

  /**
   * Waits a judgment can no longer answer usefully. Past this window a late
   * notification would not fire, so the request ends rather than holding its
   * conversations ahead of the queue for the rest of the session.
   */
  private expirePriority(): void {
    const cutoff = this.time.now() - SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS
    for (const request of [...this.priority]) {
      if (request.createdAt > cutoff) continue
      const index = this.priority.indexOf(request)
      if (index >= 0) this.priority.splice(index, 1)
      if (request.resolved) continue
      request.resolved = true
      request.resolve()
    }
    const waiting = new Set<string>()
    for (const request of this.priority) for (const threadId of request.pending) waiting.add(threadId)
    for (const threadId of [...this.priorityThreads]) {
      if (!waiting.has(threadId)) this.priorityThreads.delete(threadId)
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

/** Honour Retry-After when it is sane, else the doubling ladder from one second. */
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
