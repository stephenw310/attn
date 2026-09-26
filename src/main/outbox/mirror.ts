import { createReadStream, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DraftKind } from '../../shared/drafts'
import { errorMessage } from '../../shared/error'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { isPathInside } from '../pathSafety'
import type { DraftProvider, ProviderDraft } from '../sync/provider'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './draftAttachments'
import {
  type DraftMimeInput,
  type DraftMimeStreamAttachment,
  draftMimeByteLength,
  encodeDraftMessage,
  streamDraftMessage
} from './draftMime'
import { draftContentFingerprint, refreshRemoteAttachmentLocators, remoteDraftAttachments } from './draftSync'
import { shouldMirrorDraft } from './drafts'
import type { MimeStreamAttachment } from './mime'
import { outboxDraftContent, outboxDraftInput } from './row'

interface DraftMirrorRow {
  id: string
  state: 'composing' | 'drafted' | 'discarding'
  kind: DraftKind
  gmail_draft_id: string | null
  sender_email?: string | null
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
  source_message_id: string | null
  local_revision: number
  default_signature_fingerprint: string | null
}

export class DraftMirrorRowError extends Error {
  constructor(
    readonly rowId: string,
    readonly reason: unknown
  ) {
    super(errorMessage(reason))
    this.name = 'DraftMirrorRowError'
  }
}

function nextPending(
  db: Db,
  accountId: string,
  skip: (rowId: string) => boolean
): DraftMirrorRow | undefined {
  const rows = db
    .prepare(
      `SELECT id, state, kind, gmail_draft_id, sender_email, to_json, cc_json, bcc_json, subject, body_html,
              body_text, attachments_json, thread_id, in_reply_to, references_json, quote_html,
              quote_text, source_message_id, local_revision, default_signature_fingerprint
       FROM outbox
       WHERE account_id = ? AND (
         state = 'discarding' OR
         (state IN ('composing', 'drafted') AND local_revision > mirror_revision)
       )
       ORDER BY CASE state WHEN 'discarding' THEN 0 ELSE 1 END, updated_at
      `
    )
    .all(accountId) as DraftMirrorRow[]
  // Any drain trigger reaches these rows, not only the composer's own
  // checkpoint request, so the gate here must be the IPC gate: a
  // crash-recovered reply the user never contributed to has work pending
  // (local_revision 1, mirror_revision 0) and must still stay out of Gmail.
  return rows.find(
    (row) =>
      !skip(row.id) &&
      (row.state === 'discarding' ||
        shouldMirrorDraft(outboxDraftInput(row), row.local_revision, row.default_signature_fingerprint))
  )
}

export async function saveDraftCheckpoint(
  provider: Pick<DraftProvider, 'createDraft' | 'updateDraft'>,
  id: string | null,
  raw: string,
  onRemoteMissing: () => boolean,
  threadId: string | null = null,
  signal?: AbortSignal
): Promise<string | null> {
  const request = threadId ? { raw, threadId } : { raw }
  const options = { signal, priority: 'foreground' as const }
  if (!id) return provider.createDraft(request, options)
  try {
    return await provider.updateDraft({ ...request, id }, options)
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404)) throw error
    if (!onRemoteMissing()) return null
    return provider.createDraft(request, options)
  }
}

export async function deleteDraftCheckpoint(
  provider: Pick<DraftProvider, 'deleteDraft'>,
  id: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    if (signal) await provider.deleteDraft(id, { signal })
    else await provider.deleteDraft(id)
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404)) throw error
  }
}

/**
 * Gmail mints a new message id every time a draft is rewritten, and the
 * attachment ids stored beside it rotate with it. A draft that keeps bytes only
 * in Gmail therefore holds a dead locator from its own previous checkpoint, so
 * re-read them from the live draft before hydrating anything remote. Drafts
 * whose parts are all spooled or carried inline never pay for this.
 */
async function refreshRemoteAttachmentIds(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: DraftProvider,
  signal?: AbortSignal
): Promise<StoredDraftAttachment[]> {
  const attachments = parseStoredDraftAttachments(row.attachments_json)
  const remoteOnly = attachments.some(
    (attachment) =>
      !attachment.spoolPath &&
      attachment.remoteMessageId &&
      attachment.remoteAttachmentId &&
      !attachment.remoteInlineData
  )
  if (!remoteOnly || !row.gmail_draft_id) return attachments
  let remote: ProviderDraft
  try {
    remote = await provider.getDraft(row.gmail_draft_id, { signal })
  } catch (error) {
    // A missing draft is recreated below; anything else retries with the
    // locators we already hold rather than failing the whole checkpoint.
    if (error instanceof GmailApiError) return attachments
    throw error
  }
  const refreshed = refreshRemoteAttachmentLocators(
    row.attachments_json,
    remoteDraftAttachments(remote.message)
  )
  if (refreshed === row.attachments_json) return attachments
  const changed = db
    .prepare(
      `UPDATE outbox SET attachments_json = ?
       WHERE account_id = ? AND id = ? AND attachments_json = ?`
    )
    .run(refreshed, accountId, row.id, row.attachments_json).changes
  // A concurrent attachment mutation wins; the next checkpoint refreshes again.
  if (changed === 0) return attachments
  row.attachments_json = refreshed
  return parseStoredDraftAttachments(refreshed)
}

/**
 * Attachment bytes stream through an idempotent PUT, which can take long enough
 * that a quit aborts it. The freshly minted draft id is therefore persisted
 * before the upload starts: an aborted upload leaves `mirror_revision` behind
 * `local_revision`, so the next drain resumes against the same remote draft
 * instead of creating a second one.
 */
async function streamDraftCheckpoint(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: DraftProvider,
  body: Omit<DraftMimeInput, 'attachments'>,
  attachments: readonly StoredDraftAttachment[],
  spoolRoot: string | null,
  onRemoteMissing: () => boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const prepared = await prepareDraftMimeAttachments(row.id, attachments, provider, spoolRoot, signal)
  const message: DraftMimeInput<DraftMimeStreamAttachment> = { ...body, attachments: prepared }
  const upload = {
    sizeBytes: draftMimeByteLength(message),
    open: () => streamDraftMessage(message)
  }

  const create = async (): Promise<string | null> => {
    const created = await saveDraftCheckpoint(
      provider,
      null,
      encodeDraftMessage(body),
      onRemoteMissing,
      row.thread_id,
      signal
    )
    if (!created) return null
    const persisted = db
      .prepare('UPDATE outbox SET gmail_draft_id = ? WHERE account_id = ? AND id = ?')
      .run(created, accountId, row.id)
    // The row can be discarded and hard-deleted while this create is in
    // flight (closeDraft removes an effectively-empty row that has no remote
    // id yet). A create is not idempotent, so the draft Gmail just minted has
    // to be deleted here — otherwise it stays in Gmail and draft sync imports
    // it back as a fresh row holding the text the user just discarded.
    if (persisted.changes === 0) {
      await deleteDraftCheckpoint(provider, created, signal)
      return null
    }
    return created
  }

  const id = row.gmail_draft_id ?? (await create())
  if (!id) return null
  const request = row.thread_id ? { id, mime: upload, threadId: row.thread_id } : { id, mime: upload }
  try {
    return await provider.updateDraft(request, { signal })
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404)) throw error
    if (!onRemoteMissing()) return null
    const recreated = await create()
    if (!recreated) return null
    return provider.updateDraft(
      row.thread_id
        ? { id: recreated, mime: upload, threadId: row.thread_id }
        : { id: recreated, mime: upload },
      { signal }
    )
  }
}

async function mirrorComposing(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: DraftProvider,
  spoolRoot: string | null,
  signal?: AbortSignal
): Promise<boolean> {
  const mirroredAttachments = await refreshRemoteAttachmentIds(db, accountId, row, provider, signal)
  const content = outboxDraftContent(row)
  // The MIME body carries authored content only: attachments are prepared
  // separately below, and the thread id rides on the Gmail request instead.
  const { attachments: _attachments, threadId: _threadId, ...fields } = content
  const body = { ...fields, senderEmail: content.senderEmail ?? accountId }
  const onRemoteMissing = (): boolean => {
    db.prepare(
      `UPDATE outbox SET gmail_draft_id = NULL, mirror_revision = 0
       WHERE account_id = ? AND id = ? AND gmail_draft_id = ?`
    ).run(accountId, row.id, row.gmail_draft_id)
    const current = db
      .prepare('SELECT state FROM outbox WHERE account_id = ? AND id = ?')
      .get(accountId, row.id) as { state: string } | undefined
    return current?.state === 'composing' || current?.state === 'drafted'
  }
  // Streaming keeps a 25 MB attachment out of memory, but Gmail's upload
  // endpoint is PUT-only, so a draft with no id yet is created from its body
  // alone and the bytes follow.
  const gmailDraftId =
    mirroredAttachments.length > 0
      ? await streamDraftCheckpoint(
          db,
          accountId,
          row,
          provider,
          body,
          mirroredAttachments,
          spoolRoot,
          onRemoteMissing,
          signal
        )
      : await saveDraftCheckpoint(
          provider,
          row.gmail_draft_id,
          encodeDraftMessage(body),
          onRemoteMissing,
          row.thread_id,
          signal
        )
  if (!gmailDraftId) return false
  const fingerprint = draftContentFingerprint({ ...content, attachments: mirroredAttachments })
  const persisted = db
    .prepare(
      `UPDATE outbox SET gmail_draft_id = ?,
         mirror_revision = CASE WHEN state IN ('composing', 'drafted') THEN ? ELSE mirror_revision END,
         remote_fingerprint = CASE WHEN state IN ('composing', 'drafted') THEN ? ELSE remote_fingerprint END
       WHERE account_id = ? AND id = ?`
    )
    .run(gmailDraftId, row.local_revision, fingerprint, accountId, row.id)
  // Same discard race as the streaming create above, for the buffered path
  // that creates and checkpoints in one call.
  if (persisted.changes === 0 && gmailDraftId !== row.gmail_draft_id) {
    await deleteDraftCheckpoint(provider, gmailDraftId, signal)
  }
  return true
}

function bufferSource(content: Uint8Array): () => AsyncIterable<Uint8Array> {
  return async function* () {
    yield content
  }
}

export class DraftAttachmentSourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

export function isRetryableAttachmentFilesystemError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code !== 'ENOENT' && code !== 'ENOTDIR'
}

function filesystemAttachmentError(filename: string, error: unknown): DraftAttachmentSourceError {
  return new DraftAttachmentSourceError(
    `local attachment unavailable: ${filename}`,
    isRetryableAttachmentFilesystemError(error)
  )
}

function fileSource(path: string, filename: string, expectedBytes: number): () => AsyncIterable<Uint8Array> {
  return async function* () {
    let readBytes = 0
    try {
      for await (const value of createReadStream(path)) {
        const chunk = Buffer.from(value)
        if (readBytes + chunk.byteLength > expectedBytes) {
          throw new DraftAttachmentSourceError(`local attachment changed unexpectedly: ${filename}`, false)
        }
        readBytes += chunk.byteLength
        yield chunk
      }
      if (readBytes !== expectedBytes) {
        throw new DraftAttachmentSourceError(`local attachment changed unexpectedly: ${filename}`, false)
      }
    } catch (error) {
      // Never let a main-owned spool locator escape through an outbox error.
      if (error instanceof DraftAttachmentSourceError) throw error
      throw filesystemAttachmentError(filename, error)
    }
  }
}

/** Validate every source before draft creation, then return replayable send-time streams. */
export async function prepareDraftMimeAttachments(
  draftId: string,
  attachments: readonly StoredDraftAttachment[],
  provider: Pick<DraftProvider, 'getAttachmentData'>,
  spoolRoot: string | null,
  signal?: AbortSignal
): Promise<MimeStreamAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      let sizeBytes = attachment.sizeBytes
      let open: () => AsyncIterable<Uint8Array>
      if (attachment.spoolPath) {
        if (!spoolRoot) throw new Error(`local attachment root unavailable: ${attachment.filename}`)
        const draftRoot = resolve(spoolRoot, draftId)
        const candidate = resolve(attachment.spoolPath)
        if (!isPathInside(draftRoot, candidate)) {
          throw new Error(`local attachment path escaped its draft: ${attachment.filename}`)
        }
        let details: Stats
        try {
          details = await stat(candidate)
        } catch (error) {
          throw filesystemAttachmentError(attachment.filename, error)
        }
        if (!details.isFile() || details.size !== attachment.sizeBytes) {
          throw new DraftAttachmentSourceError(
            `local attachment changed unexpectedly: ${attachment.filename}`,
            false
          )
        }
        sizeBytes = details.size
        open = fileSource(candidate, attachment.filename, details.size)
      } else {
        let content: Buffer
        if (attachment.remoteInlineData) {
          content = Buffer.from(attachment.remoteInlineData, 'base64url')
        } else if (attachment.remoteMessageId && attachment.remoteAttachmentId) {
          const data = await provider.getAttachmentData(
            attachment.remoteMessageId,
            attachment.remoteAttachmentId,
            signal ? { signal } : undefined
          )
          if (!data) {
            throw new DraftAttachmentSourceError(
              `remote attachment unavailable: ${attachment.filename}`,
              true
            )
          }
          content = Buffer.from(data, 'base64url')
        } else {
          throw new Error(`attachment unavailable: ${attachment.filename}`)
        }
        sizeBytes = content.byteLength
        open = bufferSource(content)
      }
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes,
        open,
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        ...(attachment.inline ? { inline: true } : {})
      }
    })
  )
}

async function deleteDiscarded(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: DraftProvider | null,
  signal?: AbortSignal
): Promise<boolean> {
  if (row.gmail_draft_id) {
    if (!provider) return false
    await deleteDraftCheckpoint(provider, row.gmail_draft_id, signal)
  }
  db.prepare("DELETE FROM outbox WHERE account_id = ? AND id = ? AND state = 'discarding'").run(
    accountId,
    row.id
  )
  return true
}

/** Drain best-effort checkpoints independently from the user-action queue. */
export async function drainDraftMirrors(
  db: Db,
  accountId: string,
  provider: DraftProvider | null,
  shouldContinue: () => boolean = () => true,
  spoolRoot: string | null = null,
  signal?: AbortSignal,
  skip: (rowId: string) => boolean = () => false
): Promise<void> {
  while (shouldContinue()) {
    const row = nextPending(db, accountId, skip)
    if (!row) return
    let progressed: boolean
    try {
      progressed =
        row.state === 'discarding'
          ? await deleteDiscarded(db, accountId, row, provider, signal)
          : provider
            ? await mirrorComposing(db, accountId, row, provider, spoolRoot, signal)
            : false
    } catch (error) {
      throw new DraftMirrorRowError(row.id, error)
    }
    if (!progressed) return
  }
}
