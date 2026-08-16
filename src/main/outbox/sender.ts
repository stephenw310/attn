import type { MailAddress } from '../../shared/address'
import type { DraftKind } from '../../shared/drafts'
import type { OutboxChanged } from '../../shared/outbox'
import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { isOfflineFailure } from '../sync/failure'
import { persistThread } from '../sync/persist'
import type { MailProvider } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { parseStoredDraftAttachments } from './draftAttachments'
import { planTransition } from './machine'
import { buildMime } from './mime'
import { loadDraftMimeAttachments } from './mirror'

const SECONDARY_CHECK_MS = 10_000
const SECONDARY_CHECKS = 6
const OFFLINE_RECHECK_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
export const SENT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const NEEDS_REVIEW_EXPLANATION = "We couldn't confirm this was sent — check your Sent mail before resending"
const SEND_FAILURE_TOAST = 'Message could not be sent'

interface SendRow {
  id: string
  account_id: string
  state: 'queued' | 'sending'
  kind: DraftKind
  gmail_draft_id: string | null
  rfc_message_id: string
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_html: string
  body_text: string
  attachments_json: string
  thread_id: string | null
  in_reply_to: string | null
  references_json: string
  quote_html: string
  quote_text: string
  updated_at: number
  send_at: number | null
  attempts: number
  verify_attempts: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function permanentSendError(error: unknown): boolean {
  return (
    error instanceof GmailApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 404 &&
    !error.retryable
  )
}

class OutboxNoRemoteMutationError extends Error {
  constructor(readonly reason: unknown) {
    super(errorMessage(reason))
  }
}

export function isRetryableOutboxPreflightError(error: unknown): boolean {
  return (error instanceof GmailApiError && error.retryable) || isOfflineFailure(error)
}

export type DraftPresence = 'present' | 'consumed'

export async function verifyKnownDraft(
  provider: MailProvider,
  id: string,
  signal?: AbortSignal
): Promise<DraftPresence> {
  try {
    await provider.getDraft(id, { signal })
    return 'present'
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return 'consumed'
    throw error
  }
}

export interface DraftSendProtocolInput {
  gmailDraftId: string | null
  raw: string
  threadId: string | null
  persistCreatedId: (id: string) => boolean | Promise<boolean>
}

export type DraftSendProtocolResult =
  | { kind: 'sent'; threadId: string }
  | { kind: 'consumed' }
  | { kind: 'missing-before-send' }
  | { kind: 'aborted' }

/**
 * Network protocol beneath the durable machine. A new Gmail id is persisted
 * before update/send, and a failed persistence callback is a hard stop.
 */
export async function executeDraftSendProtocol(
  provider: MailProvider,
  input: DraftSendProtocolInput,
  signal?: AbortSignal
): Promise<DraftSendProtocolResult> {
  if (!provider.createDraft || !provider.updateDraft || !provider.sendDraft) {
    throw new Error('Gmail draft sending is unavailable')
  }
  let gmailDraftId = input.gmailDraftId
  if (!gmailDraftId) {
    try {
      gmailDraftId = await provider.createDraft({ raw: input.raw, threadId: input.threadId }, { signal })
    } catch (error) {
      // A normal 4xx is a definitive rejection, but 408 specifically means the
      // request outcome is unknown and must enter Message-ID verification.
      if (
        error instanceof GmailApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        throw new OutboxNoRemoteMutationError(error)
      }
      throw error
    }
    if (!gmailDraftId) throw new Error('Gmail draft create returned no id')
    if (!(await input.persistCreatedId(gmailDraftId))) return { kind: 'aborted' }
  }
  try {
    await provider.updateDraft({ id: gmailDraftId, raw: input.raw, threadId: input.threadId }, { signal })
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return { kind: 'missing-before-send' }
    throw error
  }
  try {
    const sent = await provider.sendDraft(gmailDraftId, { signal })
    return { kind: 'sent', threadId: sent.threadId }
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return { kind: 'consumed' }
    throw error
  }
}

/** The sole production chokepoint that may call Gmail drafts.send. */
export class OutboxSender {
  private drainPromise: Promise<void> | null = null
  private remoteAbortController: AbortController | null = null
  private stopping = false
  private timer: TimerHandle | null = null

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailProvider | null,
    private readonly notify: (change: OutboxChanged) => void,
    private readonly beforeRemote: () => Promise<void> = () => Promise.resolve(),
    private readonly time: SchedulerTime = systemTime,
    private readonly spoolRoot: string | null = null,
    private readonly cleanSpool: (id: string) => void = () => {}
  ) {}

  start(): void {
    this.stopping = false
    const accountId = this.accountId()
    if (accountId) this.pruneSent(accountId)
    this.refresh()
  }

  refresh(): void {
    if (this.stopping) return
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    if (this.drainPromise) return
    this.armFromDatabase()
  }

  trigger(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null
      if (!this.stopping && !this.timer) this.armFromDatabase()
    })
    return this.drainPromise
  }

  /** True only while send recovery or delivery is active, not while an undo/retry timer is idle. */
  isRunning(): boolean {
    return this.drainPromise !== null
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    const drain = this.drainPromise
    if (!drain) return
    let timeout: TimerHandle | null = null
    const timedOut = await Promise.race([
      drain.then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = this.time.timers.setTimeout(() => resolve(true), STOP_TIMEOUT_MS)
      })
    ])
    if (timeout) this.time.timers.clearTimeout(timeout)
    if (!timedOut) return
    this.remoteAbortController?.abort(new Error('outbox shutdown'))
    await drain
  }

  private armFromDatabase(): void {
    const accountId = this.accountId()
    if (!accountId) return
    const next = this.db
      .prepare(
        `SELECT state, send_at FROM outbox
         WHERE account_id = ? AND state IN ('queued', 'sending')
         ORDER BY CASE WHEN send_at IS NULL THEN 0 ELSE 1 END, send_at LIMIT 1`
      )
      .get(accountId) as { state: string; send_at: number | null } | undefined
    if (!next) return
    const now = this.time.now()
    const delay = next.send_at === null ? 0 : Math.max(0, next.send_at - now)
    this.timer = this.time.timers.setTimeout(() => {
      this.timer = null
      void this.trigger()
    }, delay)
  }

  private nextDue(accountId: string): SendRow | undefined {
    return this.db
      .prepare(
        `SELECT id, account_id, state, kind, gmail_draft_id, rfc_message_id, to_json, cc_json,
                bcc_json, subject, body_html, body_text, attachments_json, thread_id, in_reply_to,
                references_json, quote_html, quote_text, updated_at, send_at, attempts, verify_attempts
         FROM outbox
         WHERE account_id = ? AND state IN ('queued', 'sending')
           AND (send_at IS NULL OR send_at <= ?)
         ORDER BY CASE state WHEN 'sending' THEN 0 ELSE 1 END, COALESCE(send_at, 0), updated_at
         LIMIT 1`
      )
      .get(accountId, this.time.now()) as SendRow | undefined
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) {
      this.timer = this.time.timers.setTimeout(() => {
        this.timer = null
        void this.trigger()
      }, OFFLINE_RECHECK_MS)
      return
    }

    for (;;) {
      if (this.stopping || this.accountId() !== accountId) return
      let row = this.nextDue(accountId)
      if (!row) return
      const recovering = row.state === 'sending'
      let checkpointWaited = false
      if (row.state === 'queued') {
        // A mirror create may already own this row. Let it persist its Gmail id
        // while the row is still safely queued, then claim `sending` immediately
        // before the send-side protocol starts.
        try {
          await this.beforeRemote()
        } catch (error) {
          console.warn(`[outbox] draft checkpoint wait failed: ${errorMessage(error)}`)
          this.timer = this.time.timers.setTimeout(() => {
            this.timer = null
            void this.trigger()
          }, retryDelayMs(row.attempts))
          return
        }
        checkpointWaited = true
        if (this.stopping || this.accountId() !== accountId) return
        const plan = planTransition(
          {
            state: row.state,
            gmailDraftId: row.gmail_draft_id,
            sendAt: row.send_at,
            attempts: row.attempts,
            verifyAttempts: row.verify_attempts
          },
          { type: 'timer' },
          this.time.now()
        )
        if (plan.next.state !== 'sending') return
        const claimed = this.db
          .prepare("UPDATE outbox SET state = 'sending' WHERE account_id = ? AND id = ? AND state = 'queued'")
          .run(accountId, row.id)
        if (claimed.changes === 0) continue
        row = { ...row, state: 'sending' }
        this.notify({ kind: 'changed' })
      }

      const retryingLater = await this.processSending(row, provider, recovering, checkpointWaited)
      if (retryingLater) return
    }
  }

  private reloadSending(accountId: string, id: string): SendRow | undefined {
    return this.db
      .prepare(
        `SELECT id, account_id, state, kind, gmail_draft_id, rfc_message_id, to_json, cc_json,
                bcc_json, subject, body_html, body_text, attachments_json, thread_id, in_reply_to,
                references_json, quote_html, quote_text, updated_at, send_at, attempts, verify_attempts
         FROM outbox WHERE account_id = ? AND id = ? AND state = 'sending'`
      )
      .get(accountId, id) as SendRow | undefined
  }

  private async processSending(
    initial: SendRow,
    provider: MailProvider,
    recovering: boolean,
    checkpointWaited: boolean
  ): Promise<boolean> {
    const controller = new AbortController()
    this.remoteAbortController = controller
    try {
      if (!checkpointWaited) await this.beforeRemote()
      if (this.stopping || this.accountId() !== initial.account_id) return true
      const row = this.reloadSending(initial.account_id, initial.id)
      if (!row) return false
      if (recovering) {
        const recovery = planTransition(
          {
            state: row.state,
            gmailDraftId: row.gmail_draft_id,
            sendAt: row.send_at,
            attempts: row.attempts,
            verifyAttempts: row.verify_attempts
          },
          { type: 'recover' },
          this.time.now()
        )
        if (recovery.effects.includes('verify-secondary')) {
          return this.verifySecondary(row, provider, controller.signal)
        }
        if (recovery.effects.includes('verify')) {
          if (
            (await verifyKnownDraft(provider, row.gmail_draft_id as string, controller.signal)) === 'consumed'
          ) {
            await this.markSent(row, provider, row.thread_id, controller.signal)
            return false
          }
        }
      }

      await this.send(row, provider, controller.signal)
      return false
    } catch (error) {
      return this.handleError(initial, error)
    } finally {
      if (this.remoteAbortController === controller) this.remoteAbortController = null
    }
  }

  private async verifySecondary(row: SendRow, provider: MailProvider, signal: AbortSignal): Promise<boolean> {
    if (!provider.findByRfcId) throw new Error('Gmail Message-ID verification is unavailable')
    const match = await provider.findByRfcId(row.rfc_message_id, { signal })
    if (match?.kind === 'message') {
      await this.markSent(row, provider, match.threadId ?? row.thread_id, signal)
      return false
    }
    if (match?.kind === 'draft') {
      this.db
        .prepare(
          `UPDATE outbox SET gmail_draft_id = ?, attempts = 0, verify_attempts = 0, last_error = NULL
           WHERE account_id = ? AND id = ? AND state = 'sending' AND gmail_draft_id IS NULL`
        )
        .run(match.draftId, row.account_id, row.id)
      const recovered = this.reloadSending(row.account_id, row.id)
      if (!recovered) return false
      const durableDraftId = recovered.gmail_draft_id
      if (!durableDraftId) return false
      if ((await verifyKnownDraft(provider, durableDraftId, signal)) === 'consumed') {
        await this.markSent(
          recovered,
          provider,
          durableDraftId === match.draftId ? (match.threadId ?? recovered.thread_id) : recovered.thread_id,
          signal
        )
        return false
      }
      await this.send(recovered, provider, signal)
      return false
    }

    const exhausted = row.verify_attempts + 1 >= SECONDARY_CHECKS
    const retryAt = this.time.now() + SECONDARY_CHECK_MS
    const plan = planTransition(
      {
        state: row.state,
        gmailDraftId: row.gmail_draft_id,
        sendAt: row.send_at,
        attempts: row.attempts,
        verifyAttempts: row.verify_attempts
      },
      { type: 'secondary-negative', exhausted, retryAt },
      this.time.now()
    )
    const persisted = this.db
      .prepare(
        `UPDATE outbox SET state = ?, send_at = ?, attempts = ?, verify_attempts = ?, last_error = ?
         WHERE account_id = ? AND id = ? AND state = 'sending' AND gmail_draft_id IS NULL`
      )
      .run(
        plan.next.state,
        plan.next.sendAt,
        plan.next.attempts,
        plan.next.verifyAttempts,
        plan.next.state === 'needs-review' ? NEEDS_REVIEW_EXPLANATION : null,
        row.account_id,
        row.id
      )
    if (persisted.changes === 0) return false
    if (plan.next.state === 'needs-review') {
      this.notify({ kind: 'failed', id: row.id, error: NEEDS_REVIEW_EXPLANATION })
      return false
    }
    this.notify({ kind: 'changed' })
    return true
  }

  private async buildRaw(row: SendRow, provider: MailProvider): Promise<string> {
    const attachments = await loadDraftMimeAttachments(
      row.id,
      parseStoredDraftAttachments(row.attachments_json),
      provider,
      this.spoolRoot
    )
    const mime = buildMime(
      {
        to: parseJson<MailAddress[]>(row.to_json),
        cc: parseJson<MailAddress[]>(row.cc_json),
        bcc: parseJson<MailAddress[]>(row.bcc_json),
        subject: row.subject,
        bodyHtml: row.body_html,
        bodyText: row.body_text,
        quoteHtml: row.quote_html,
        quoteText: row.quote_text,
        inReplyTo: row.in_reply_to,
        references: parseJson<string[]>(row.references_json),
        attachments
      },
      {
        accountEmail: row.account_id,
        rfcMessageId: row.rfc_message_id,
        date: new Date(row.send_at ?? row.updated_at)
      }
    )
    return Buffer.from(mime).toString('base64url')
  }

  private async send(row: SendRow, provider: MailProvider, signal: AbortSignal): Promise<void> {
    if (!provider.createDraft || !provider.updateDraft || !provider.sendDraft) {
      throw new OutboxNoRemoteMutationError(new Error('Gmail draft sending is unavailable'))
    }
    let raw: string
    try {
      raw = await this.buildRaw(row, provider)
    } catch (error) {
      throw new OutboxNoRemoteMutationError(error)
    }
    const result = await executeDraftSendProtocol(
      provider,
      {
        gmailDraftId: row.gmail_draft_id,
        raw,
        threadId: row.thread_id,
        persistCreatedId: (gmailDraftId) =>
          this.db
            .prepare(
              `UPDATE outbox SET gmail_draft_id = ?, attempts = 0, verify_attempts = 0, last_error = NULL
               WHERE account_id = ? AND id = ? AND state = 'sending' AND gmail_draft_id IS NULL`
            )
            .run(gmailDraftId, row.account_id, row.id).changes > 0
      },
      signal
    )
    if (result.kind === 'aborted') return
    if (result.kind === 'missing-before-send') {
      this.parkNeedsReview(row, true)
      return
    }
    await this.markSent(
      row,
      provider,
      result.kind === 'sent' ? result.threadId || row.thread_id : row.thread_id,
      signal
    )
  }

  private parkNeedsReview(row: SendRow, clearDraftId: boolean): void {
    const plan = planTransition(
      {
        state: row.state,
        gmailDraftId: row.gmail_draft_id,
        sendAt: row.send_at,
        attempts: row.attempts,
        verifyAttempts: row.verify_attempts
      },
      { type: 'needs-review' },
      this.time.now()
    )
    const parked = this.db
      .prepare(
        `UPDATE outbox SET state = ?, gmail_draft_id = CASE WHEN ? THEN NULL ELSE gmail_draft_id END,
         send_at = NULL, attempts = ?, verify_attempts = ?, last_error = ?
         WHERE account_id = ? AND id = ? AND state = 'sending'`
      )
      .run(
        plan.next.state,
        clearDraftId ? 1 : 0,
        plan.next.attempts,
        plan.next.verifyAttempts,
        NEEDS_REVIEW_EXPLANATION,
        row.account_id,
        row.id
      )
    if (parked.changes === 0) return
    this.notify({ kind: 'failed', id: row.id, error: NEEDS_REVIEW_EXPLANATION })
  }

  private handleError(row: SendRow, error: unknown): boolean {
    const current = this.reloadSending(row.account_id, row.id)
    if (!current) return false
    const noRemoteMutation = error instanceof OutboxNoRemoteMutationError
    const cause = noRemoteMutation ? error.reason : error
    const permanent = noRemoteMutation ? !isRetryableOutboxPreflightError(cause) : permanentSendError(cause)
    const retryAt = this.time.now() + retryDelayMs(current.attempts)
    const plan = planTransition(
      {
        state: current.state,
        gmailDraftId: current.gmail_draft_id,
        sendAt: current.send_at,
        attempts: current.attempts,
        verifyAttempts: current.verify_attempts
      },
      permanent
        ? { type: 'permanent-error' }
        : noRemoteMutation
          ? { type: 'preflight-retry', retryAt }
          : current.gmail_draft_id === null
            ? { type: 'verification-error', retryAt }
            : { type: 'retryable-error', retryAt },
      this.time.now()
    )
    const persisted = this.db
      .prepare(
        `UPDATE outbox SET state = ?, send_at = ?, attempts = ?, verify_attempts = ?, last_error = ?
         WHERE account_id = ? AND id = ? AND state = 'sending'`
      )
      .run(
        plan.next.state,
        plan.next.sendAt,
        plan.next.attempts,
        plan.next.verifyAttempts,
        errorMessage(cause),
        current.account_id,
        current.id
      )
    if (persisted.changes === 0) return false
    if (permanent) {
      this.notify({ kind: 'failed', id: current.id, error: SEND_FAILURE_TOAST })
      return false
    }
    this.notify({ kind: 'changed' })
    return true
  }

  private async markSent(
    row: SendRow,
    provider: MailProvider,
    threadId: string | null,
    signal: AbortSignal
  ): Promise<void> {
    const now = this.time.now()
    const settled = this.db
      .prepare(
        `UPDATE outbox SET state = 'sent', send_at = NULL, last_error = NULL, updated_at = ?
         WHERE account_id = ? AND id = ? AND state = 'sending'`
      )
      .run(now, row.account_id, row.id)
    if (settled.changes === 0) return
    this.cleanSpool(row.id)
    this.pruneSent(row.account_id, now)
    this.notify({ kind: 'changed' })
    // Sending is already durably settled. Do not make normal shutdown or an
    // account switch wait on the best-effort post-send conversation refresh.
    if (!threadId || this.stopping || this.accountId() !== row.account_id) return
    try {
      const thread = await provider.getThread(threadId, { format: 'full', signal })
      persistThread(this.db, row.account_id, thread)
      this.notify({ kind: 'changed' })
    } catch (error) {
      console.warn(`[outbox] sent ${row.id}, but refresh failed: ${errorMessage(error)}`)
    }
  }

  private pruneSent(accountId: string, now = this.time.now()): void {
    this.db
      .prepare("DELETE FROM outbox WHERE account_id = ? AND state = 'sent' AND updated_at < ?")
      .run(accountId, now - SENT_OUTBOX_RETENTION_MS)
  }
}
