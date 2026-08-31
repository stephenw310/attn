import type { MailAddress } from '../../shared/address'
import type { DraftKind } from '../../shared/drafts'
import { errorMessage } from '../../shared/error'
import type { OutboxChanged, OutboxProgress } from '../../shared/outbox'
import { NEEDS_REVIEW_EXPLANATION } from '../../shared/outbox'
import {
  MAX_ATTACHMENT_SOURCE_ATTEMPTS,
  OUTBOX_OFFLINE_RECHECK_MS,
  OUTBOX_STOP_TIMEOUT_MS,
  SECONDARY_CHECK_MS,
  SECONDARY_CHECKS,
  SENT_OUTBOX_RETENTION_MS
} from '../../shared/outboxTuning'
import { retryDelayMs } from '../actions/execute'
import type { Db } from '../db'
import { createFollowUpOnSent, evaluateThreadFollowUp, resolveFollowUpOrigins } from '../followUps'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import { readAccountSetting } from '../settings'
import { isOfflineFailure } from '../sync/failure'
import { persistThread } from '../sync/persist'
import type { MailProvider, ProviderMimeUpload } from '../sync/provider'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { parseStoredDraftAttachments } from './draftAttachments'
import { planTransition } from './machine'
import { buildMime, mimeByteLength, streamMime } from './mime'
import { DraftAttachmentSourceError, prepareDraftMimeAttachments } from './mirror'
import { primarySenderDisplayName, SEND_AS_DISPLAY_NAME_SETTING, syncPrimarySendAs } from './sendAs'
import { validateAttachmentCap } from './spool'

interface SendRow {
  id: string
  account_id: string
  state: 'queued' | 'sending'
  kind: DraftKind
  gmail_draft_id: string | null
  gmail_message_id: string | null
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
  created_at: number
  updated_at: number
  follow_up_at: number | null
  send_at: number | null
  attempts: number
  verify_attempts: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
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

export function userFacingSendError(error: unknown): string {
  if (error instanceof DraftAttachmentSourceError) {
    return error.retryable
      ? 'An attachment is temporarily unavailable — Attn will retry'
      : 'An attachment could not be read — reopen the message and attach it again'
  }
  // The client refreshes on a bare 401, so a revoked/expired refresh token
  // surfaces as GmailAuthError from the token endpoint, not as a 401 response.
  if (error instanceof GmailAuthError) return 'Gmail authorization expired — sign in again and retry'
  if (error instanceof GmailApiError) {
    if (error.status === 401) return 'Gmail authorization expired — sign in again and retry'
    if (error.status === 413) return 'The message is too large for Gmail'
    if (error.status === 400) return 'Gmail rejected this message — check its recipients and attachments'
    if (error.status === 403 && !error.retryable) return 'Gmail did not allow this message to be sent'
    return 'Gmail could not send this message'
  }
  if (isOfflineFailure(error)) return 'No network connection — Attn will retry'
  if (
    error instanceof Error &&
    ['Each attachment must be 25 MB or less', 'Attachments must total 25 MB or less'].includes(error.message)
  ) {
    return error.message
  }
  return 'Message could not be sent'
}

class OutboxNoRemoteMutationError extends Error {
  constructor(readonly reason: unknown) {
    super(errorMessage(reason))
  }
}

export function isRetryableOutboxPreflightError(error: unknown): boolean {
  return (
    (error instanceof GmailApiError && error.retryable) ||
    (error instanceof DraftAttachmentSourceError && error.retryable) ||
    // The intent is still valid; it resumes after the user reconnects (T18's
    // rule for triage actions applies to sends too).
    error instanceof GmailAuthError ||
    isOfflineFailure(error)
  )
}

export type DraftPresence = 'present' | 'consumed'

export async function verifyKnownDraft(
  provider: MailProvider,
  id: string,
  signal?: AbortSignal
): Promise<DraftPresence> {
  try {
    await provider.getDraft(id, { signal, priority: 'send' })
    return 'present'
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return 'consumed'
    throw error
  }
}

export interface DraftSendProtocolInput {
  gmailDraftId: string | null
  /** Attachment-free create payload; final MIME bytes belong to updateMime. */
  raw: string
  updateMime?: ProviderMimeUpload
  threadId: string | null
  persistCreatedId: (id: string) => boolean | Promise<boolean>
}

export type DraftSendProtocolResult =
  | { kind: 'sent'; messageId: string; threadId: string }
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
      gmailDraftId = await provider.createDraft(
        { raw: input.raw, threadId: input.threadId },
        { signal, priority: 'send' }
      )
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
      // A failed token refresh happens before the request is issued (or after
      // Gmail already rejected it with 401), so no draft can exist. Treating it
      // as ambiguous would send this row into Message-ID verification after
      // reconnect and park a never-sent message in needs-review.
      if (error instanceof GmailAuthError) throw new OutboxNoRemoteMutationError(error)
      throw error
    }
    if (!gmailDraftId) throw new Error('Gmail draft create returned no id')
    if (!(await input.persistCreatedId(gmailDraftId))) return { kind: 'aborted' }
  }
  try {
    await provider.updateDraft(
      input.updateMime
        ? { id: gmailDraftId, mime: input.updateMime, threadId: input.threadId }
        : { id: gmailDraftId, raw: input.raw, threadId: input.threadId },
      { signal, priority: 'send' }
    )
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return { kind: 'missing-before-send' }
    throw error
  }
  try {
    const sent = await provider.sendDraft(gmailDraftId, { signal, priority: 'send' })
    return { kind: 'sent', messageId: sent.id, threadId: sent.threadId }
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return { kind: 'consumed' }
    throw error
  }
}

export interface OutboxSenderOptions {
  beforeRemote?: (signal?: AbortSignal) => Promise<void>
  time?: SchedulerTime
  spoolRoot?: string | null
  cleanSpool?: (id: string) => void
  progress?: (progress: OutboxProgress | null) => void
  mailChanged?: () => void
  /** A follow-up reminder was created or settled: re-arm the scheduler (T35). */
  followUpsChanged?: () => void
}

/** The sole production chokepoint that may call Gmail drafts.send. */
export class OutboxSender {
  private drainPromise: Promise<void> | null = null
  private remoteAbortController: AbortController | null = null
  private stopping = false
  private timer: TimerHandle | null = null
  private drainAttempts = 0

  private readonly beforeRemote: (signal?: AbortSignal) => Promise<void>
  private readonly time: SchedulerTime
  private readonly spoolRoot: string | null
  private readonly cleanSpool: (id: string) => void
  private readonly progress: (progress: OutboxProgress | null) => void
  private readonly mailChanged: () => void
  private readonly followUpsChanged: () => void

  constructor(
    private readonly db: Db,
    private readonly accountId: () => string | null,
    private readonly provider: () => MailProvider | null,
    private readonly notify: (change: OutboxChanged) => void,
    options: OutboxSenderOptions = {}
  ) {
    this.beforeRemote = options.beforeRemote ?? (() => Promise.resolve())
    this.time = options.time ?? systemTime
    this.spoolRoot = options.spoolRoot ?? null
    this.cleanSpool = options.cleanSpool ?? (() => {})
    this.progress = options.progress ?? (() => {})
    this.mailChanged = options.mailChanged ?? (() => {})
    this.followUpsChanged = options.followUpsChanged ?? (() => {})
  }

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
    this.drainPromise = this.drainSafely().finally(() => {
      this.drainPromise = null
    })
    return this.drainPromise
  }

  private async drainSafely(): Promise<void> {
    try {
      await this.drain()
      if (!this.stopping && !this.timer) this.armFromDatabase()
      this.drainAttempts = 0
    } catch (error) {
      if (this.stopping) return
      console.error(`[outbox] drain failed: ${errorMessage(error)}`)
      const delay = retryDelayMs(this.drainAttempts++)
      this.timer = this.time.timers.setTimeout(() => {
        this.timer = null
        void this.trigger()
      }, delay)
    }
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
        timeout = this.time.timers.setTimeout(() => resolve(true), OUTBOX_STOP_TIMEOUT_MS)
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
         WHERE account_id = ? AND (
           state = 'sending' OR (state = 'queued' AND send_at IS NOT NULL)
         )
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
        `SELECT id, account_id, state, kind, gmail_draft_id, gmail_message_id, rfc_message_id,
                to_json, cc_json,
                bcc_json, subject, body_html, body_text, attachments_json, thread_id, in_reply_to,
                references_json, quote_html, quote_text, created_at, updated_at, follow_up_at, send_at,
                attempts, verify_attempts
         FROM outbox
         WHERE account_id = ? AND (
           (state = 'sending' AND (send_at IS NULL OR send_at <= ?)) OR
           (state = 'queued' AND send_at IS NOT NULL AND send_at <= ?)
         )
         ORDER BY CASE state WHEN 'sending' THEN 0 ELSE 1 END, COALESCE(send_at, 0), updated_at
         LIMIT 1`
      )
      .get(accountId, this.time.now(), this.time.now()) as SendRow | undefined
  }

  private async drain(): Promise<void> {
    const accountId = this.accountId()
    const provider = this.provider()
    if (!accountId || !provider) {
      this.timer = this.time.timers.setTimeout(() => {
        this.timer = null
        void this.trigger()
      }, OUTBOX_OFFLINE_RECHECK_MS)
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
        const checkpointController = new AbortController()
        this.remoteAbortController = checkpointController
        try {
          await this.beforeRemote(checkpointController.signal)
        } catch (error) {
          if (this.stopping && checkpointController.signal.aborted) return
          console.warn(`[outbox] draft checkpoint wait failed: ${errorMessage(error)}`)
          this.timer = this.time.timers.setTimeout(() => {
            this.timer = null
            void this.trigger()
          }, retryDelayMs(row.attempts))
          return
        } finally {
          if (this.remoteAbortController === checkpointController) this.remoteAbortController = null
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
        `SELECT id, account_id, state, kind, gmail_draft_id, gmail_message_id, rfc_message_id,
                to_json, cc_json,
                bcc_json, subject, body_html, body_text, attachments_json, thread_id, in_reply_to,
                references_json, quote_html, quote_text, created_at, updated_at, follow_up_at, send_at,
                attempts, verify_attempts
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
      if (!checkpointWaited) await this.beforeRemote(controller.signal)
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
      if (this.stopping && controller.signal.aborted) return true
      return this.handleError(initial, error)
    } finally {
      if (this.remoteAbortController === controller) this.remoteAbortController = null
    }
  }

  private async verifySecondary(row: SendRow, provider: MailProvider, signal: AbortSignal): Promise<boolean> {
    if (!provider.findByRfcId) throw new Error('Gmail Message-ID verification is unavailable')
    const match = await provider.findByRfcId(row.rfc_message_id, { signal, priority: 'send' })
    if (match?.kind === 'message') {
      await this.markSent(row, provider, match.threadId ?? row.thread_id, signal, match.messageId)
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

  private async prepareSend(
    row: SendRow,
    provider: MailProvider,
    signal?: AbortSignal
  ): Promise<{ raw: string; updateMime?: ProviderMimeUpload }> {
    const accountName = await this.senderDisplayName(row.account_id, provider, signal)
    const storedAttachments = parseStoredDraftAttachments(row.attachments_json)
    const draft = {
      to: parseJson<MailAddress[]>(row.to_json),
      cc: parseJson<MailAddress[]>(row.cc_json),
      bcc: parseJson<MailAddress[]>(row.bcc_json),
      subject: row.subject,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      quoteHtml: row.quote_html,
      quoteText: row.quote_text,
      inReplyTo: row.in_reply_to,
      references: parseJson<string[]>(row.references_json)
    }
    const options = {
      accountEmail: row.account_id,
      accountName,
      rfcMessageId: row.rfc_message_id,
      date: new Date(row.send_at ?? row.updated_at)
    }
    const raw = Buffer.from(buildMime(draft, options)).toString('base64url')
    if (storedAttachments.length === 0) return { raw }

    validateAttachmentCap(
      0,
      storedAttachments.map((attachment) => attachment.sizeBytes)
    )
    const attachments = await prepareDraftMimeAttachments(
      row.id,
      storedAttachments,
      provider,
      this.spoolRoot,
      signal
    )
    validateAttachmentCap(
      0,
      attachments.map((attachment) => attachment.sizeBytes)
    )
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0)
    const progress = this.progress
    return {
      raw,
      updateMime: {
        sizeBytes: mimeByteLength({ ...draft, attachments }, options),
        open: () =>
          (async function* () {
            let completedBytes = 0
            progress({
              id: row.id,
              completedBytes: 0,
              totalBytes,
              completedAttachments: 0,
              totalAttachments: attachments.length
            })
            yield* streamMime({ ...draft, attachments }, options, (attachment, index) => {
              completedBytes += attachment.sizeBytes
              progress({
                id: row.id,
                completedBytes,
                totalBytes,
                completedAttachments: index + 1,
                totalAttachments: attachments.length
              })
            })
          })()
      }
    }
  }

  private async senderDisplayName(
    accountId: string,
    provider: MailProvider,
    signal?: AbortSignal
  ): Promise<string> {
    if (!provider.getSendAs) return ''
    const cached = readAccountSetting(this.db, accountId, SEND_AS_DISPLAY_NAME_SETTING)
    try {
      const sendAs = await syncPrimarySendAs(this.db, accountId, provider, {
        signal,
        priority: 'send'
      })
      return primarySenderDisplayName(this.db, accountId, sendAs?.displayName)
    } catch (error) {
      if (signal?.aborted) throw error
      if (cached === undefined) throw error
      console.warn(`[outbox] send-as refresh failed for ${accountId}: ${errorMessage(error)}`)
      return primarySenderDisplayName(this.db, accountId, cached)
    }
  }

  private async send(row: SendRow, provider: MailProvider, signal: AbortSignal): Promise<void> {
    if (!provider.createDraft || !provider.updateDraft || !provider.sendDraft) {
      throw new OutboxNoRemoteMutationError(new Error('Gmail draft sending is unavailable'))
    }
    let prepared: { raw: string; updateMime?: ProviderMimeUpload }
    try {
      prepared = await this.prepareSend(row, provider, signal)
    } catch (error) {
      throw new OutboxNoRemoteMutationError(error)
    }
    let result: DraftSendProtocolResult
    try {
      result = await executeDraftSendProtocol(
        provider,
        {
          gmailDraftId: row.gmail_draft_id,
          raw: prepared.raw,
          updateMime: prepared.updateMime,
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
    } finally {
      if (prepared.updateMime) this.progress(null)
    }
    if (result.kind === 'aborted') return
    if (result.kind === 'missing-before-send') {
      this.parkNeedsReview(row, true)
      return
    }
    await this.markSent(
      row,
      provider,
      result.kind === 'sent' ? result.threadId || row.thread_id : row.thread_id,
      signal,
      result.kind === 'sent' ? result.messageId : row.gmail_message_id
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
    // last_error is what the user reads, so the provider's own text stays here
    // in the log — otherwise a field failure leaves no diagnosable trace at all.
    console.warn(`[outbox] send failed for ${current.id}: ${errorMessage(cause)}`)
    const permanent = noRemoteMutation ? !isRetryableOutboxPreflightError(cause) : permanentSendError(cause)
    // Offline and quota keep retrying for as long as they last, but a source
    // that never comes back must stop somewhere the user can see it.
    const exhausted =
      cause instanceof DraftAttachmentSourceError && current.attempts + 1 >= MAX_ATTACHMENT_SOURCE_ATTEMPTS
    const displayError = exhausted
      ? 'An attachment is still unavailable — reopen the message and attach it again'
      : userFacingSendError(cause)
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
          ? { type: 'preflight-retry', exhausted, retryAt }
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
        displayError,
        current.account_id,
        current.id
      )
    if (persisted.changes === 0) return false
    if (plan.next.state === 'failed') {
      this.notify({ kind: 'failed', id: current.id, error: displayError })
      return false
    }
    this.notify({ kind: 'changed' })
    return true
  }

  private async markSent(
    row: SendRow,
    provider: MailProvider,
    threadId: string | null,
    signal: AbortSignal,
    gmailMessageId: string | null = row.gmail_message_id
  ): Promise<void> {
    const now = this.time.now()
    // The follow-up reminder commits with the sent transition (T35/F9): an
    // undone or failed send can never leave one behind, and a crash between
    // the two can never lose one. Its origin stays unresolved until the
    // post-send read (or the account's sync session) supplies internalDate.
    let settledChanges = 0
    this.db.transaction(() => {
      settledChanges = this.db
        .prepare(
          `UPDATE outbox SET state = 'sent', gmail_message_id = COALESCE(?, gmail_message_id),
           send_at = NULL, last_error = NULL, updated_at = ?
           WHERE account_id = ? AND id = ? AND state = 'sending'`
        )
        .run(gmailMessageId, now, row.account_id, row.id).changes
      if (settledChanges === 0 || row.follow_up_at === null) return
      if (!threadId) {
        console.warn(`[outbox] sent ${row.id} with a follow-up but no thread id — reminder skipped`)
        return
      }
      createFollowUpOnSent(this.db, row.account_id, {
        threadId,
        dueAt: row.follow_up_at,
        gmailMessageId: gmailMessageId ?? row.gmail_message_id,
        rfcMessageId: row.rfc_message_id,
        rowCreatedAt: row.created_at
      })
    })()
    if (settledChanges === 0) return
    this.cleanSpool(row.id)
    this.pruneSent(row.account_id, now)
    this.notify({ kind: 'changed' })
    // Sending is already durably settled. Do not make normal shutdown or an
    // account switch wait on the best-effort post-send conversation refresh.
    if (!threadId || this.stopping || this.accountId() !== row.account_id) return
    try {
      const thread = await provider.getThread(threadId, { format: 'full', signal, priority: 'send' })
      if (persistThread(this.db, row.account_id, thread)) this.mailChanged()
      // The read that just landed resolves the reminder's origin and settles
      // it against already-cached replies — including one fetched before the
      // sent transition committed — before any deadline can arm.
      if (row.follow_up_at !== null) {
        resolveFollowUpOrigins(this.db, row.account_id)
        evaluateThreadFollowUp(this.db, row.account_id, threadId)
        this.followUpsChanged()
      }
      this.notify({ kind: 'changed' })
    } catch (error) {
      console.warn(`[outbox] sent ${row.id}, but refresh failed: ${errorMessage(error)}`)
      if (row.follow_up_at !== null) this.followUpsChanged()
    }
  }

  private pruneSent(accountId: string, now = this.time.now()): void {
    // A sent row that is a live follow-up's origin is the ordering evidence
    // createFollowUpOnSent uses to refuse a replayed OLDER send — startup
    // prunes before recovery drains, so deleting it would let that older
    // send overwrite the newer reminder's origin and deadline (PR #101
    // review). Keep exactly those rows until their reminder settles; the
    // next prune then removes them.
    this.db
      .prepare(
        `DELETE FROM outbox WHERE account_id = ? AND state = 'sent' AND updated_at < ?
           AND (rfc_message_id IS NULL OR rfc_message_id NOT IN (
             SELECT origin_rfc_message_id FROM reminders
             WHERE account_id = outbox.account_id AND kind = 'follow_up'
               AND state IN ('pending', 'returned') AND origin_rfc_message_id IS NOT NULL))`
      )
      .run(accountId, now - SENT_OUTBOX_RETENTION_MS)
  }
}
