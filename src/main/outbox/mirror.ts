import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { MailAddress } from '../../shared/address'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './draftAttachments'
import { type DraftMimeAttachment, encodeDraftMessage } from './draftMime'
import { draftContentFingerprint } from './draftSync'
import { isEmptyDraft } from './drafts'

interface DraftMirrorRow {
  id: string
  state: 'composing' | 'drafted' | 'discarding'
  gmail_draft_id: string | null
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
  local_revision: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function nextPending(db: Db, accountId: string): DraftMirrorRow | undefined {
  const rows = db
    .prepare(
      `SELECT id, state, gmail_draft_id, to_json, cc_json, bcc_json, subject, body_html,
              body_text, attachments_json, thread_id, in_reply_to, references_json, quote_html,
              quote_text, local_revision
       FROM outbox
       WHERE account_id = ? AND (
         state = 'discarding' OR
         (state IN ('composing', 'drafted') AND local_revision > mirror_revision)
       )
       ORDER BY CASE state WHEN 'discarding' THEN 0 ELSE 1 END, updated_at
      `
    )
    .all(accountId) as DraftMirrorRow[]
  return rows.find(
    (row) =>
      row.state === 'discarding' ||
      !isEmptyDraft({
        id: row.id,
        kind: 'new',
        to: parseJson<MailAddress[]>(row.to_json),
        cc: parseJson<MailAddress[]>(row.cc_json),
        bcc: parseJson<MailAddress[]>(row.bcc_json),
        subject: row.subject,
        bodyHtml: row.body_html,
        bodyText: row.body_text,
        attachments: parseStoredDraftAttachments(row.attachments_json),
        threadId: row.thread_id,
        sourceMessageId: null,
        inReplyTo: row.in_reply_to,
        references: parseJson<string[]>(row.references_json),
        quoteHtml: row.quote_html,
        quoteText: row.quote_text
      })
  )
}

export async function saveDraftCheckpoint(
  provider: Pick<MailActionProvider, 'saveDraft'>,
  id: string | null,
  raw: string,
  onRemoteMissing: () => boolean,
  threadId: string | null = null,
  signal?: AbortSignal
): Promise<string | null> {
  const saveDraft = provider.saveDraft?.bind(provider)
  if (!saveDraft) return null
  const request = threadId ? { id, raw, threadId } : { id, raw }
  const save = (next: typeof request): Promise<string> =>
    signal ? saveDraft(next, { signal }) : saveDraft(next)
  try {
    return await save(request)
  } catch (error) {
    if (!(id && error instanceof GmailApiError && error.status === 404)) throw error
    if (!onRemoteMissing()) return null
    return save(threadId ? { id: null, raw, threadId } : { id: null, raw })
  }
}

export async function deleteDraftCheckpoint(
  provider: Pick<MailActionProvider, 'deleteDraft'>,
  id: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!provider.deleteDraft) return false
  try {
    if (signal) await provider.deleteDraft(id, { signal })
    else await provider.deleteDraft(id)
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404)) throw error
  }
  return true
}

async function mirrorComposing(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: MailActionProvider,
  spoolRoot: string | null,
  signal?: AbortSignal
): Promise<boolean> {
  if (!provider.saveDraft) return false
  const attachments = parseStoredDraftAttachments(row.attachments_json)
  const mimeAttachments = await loadDraftMimeAttachments(row.id, attachments, provider, spoolRoot)
  const raw = encodeDraftMessage({
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
    attachments: mimeAttachments
  })
  const gmailDraftId = await saveDraftCheckpoint(
    provider,
    row.gmail_draft_id,
    raw,
    () => {
      db.prepare(
        `UPDATE outbox SET gmail_draft_id = NULL, mirror_revision = 0
       WHERE account_id = ? AND id = ? AND gmail_draft_id = ?`
      ).run(accountId, row.id, row.gmail_draft_id)
      const current = db
        .prepare('SELECT state FROM outbox WHERE account_id = ? AND id = ?')
        .get(accountId, row.id) as { state: string } | undefined
      return current?.state === 'composing' || current?.state === 'drafted'
    },
    row.thread_id,
    signal
  )
  if (!gmailDraftId) return false
  const fingerprint = draftContentFingerprint({
    to: parseJson<MailAddress[]>(row.to_json),
    cc: parseJson<MailAddress[]>(row.cc_json),
    bcc: parseJson<MailAddress[]>(row.bcc_json),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    attachments,
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    references: parseJson<string[]>(row.references_json),
    quoteHtml: row.quote_html,
    quoteText: row.quote_text
  })
  db.prepare(
    `UPDATE outbox SET gmail_draft_id = ?,
       mirror_revision = CASE WHEN state IN ('composing', 'drafted') THEN ? ELSE mirror_revision END,
       remote_fingerprint = CASE WHEN state IN ('composing', 'drafted') THEN ? ELSE remote_fingerprint END
     WHERE account_id = ? AND id = ?`
  ).run(gmailDraftId, row.local_revision, fingerprint, accountId, row.id)
  return true
}

export async function loadDraftMimeAttachments(
  draftId: string,
  attachments: readonly StoredDraftAttachment[],
  provider: MailActionProvider,
  spoolRoot: string | null
): Promise<DraftMimeAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      let content: Uint8Array
      if (attachment.spoolPath) {
        if (!spoolRoot) throw new Error(`local attachment root unavailable: ${attachment.filename}`)
        const draftRoot = resolve(spoolRoot, draftId)
        const candidate = resolve(attachment.spoolPath)
        const relativePath = relative(draftRoot, candidate)
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
          throw new Error(`local attachment path escaped its draft: ${attachment.filename}`)
        }
        content = await readFile(candidate)
      } else if (attachment.remoteInlineData) {
        content = Buffer.from(attachment.remoteInlineData, 'base64url')
      } else if (attachment.remoteMessageId && attachment.remoteAttachmentId && provider.getAttachmentData) {
        const data = await provider.getAttachmentData(
          attachment.remoteMessageId,
          attachment.remoteAttachmentId
        )
        if (!data) throw new Error(`remote attachment unavailable: ${attachment.filename}`)
        content = Buffer.from(data, 'base64url')
      } else {
        throw new Error(`attachment unavailable: ${attachment.filename}`)
      }
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content,
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
  provider: MailActionProvider | null,
  signal?: AbortSignal
): Promise<boolean> {
  if (row.gmail_draft_id) {
    if (!provider || !(await deleteDraftCheckpoint(provider, row.gmail_draft_id, signal))) return false
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
  provider: MailActionProvider | null,
  shouldContinue: () => boolean = () => true,
  spoolRoot: string | null = null,
  signal?: AbortSignal
): Promise<void> {
  while (shouldContinue()) {
    const row = nextPending(db, accountId)
    if (!row) return
    const progressed =
      row.state === 'discarding'
        ? await deleteDiscarded(db, accountId, row, provider, signal)
        : provider
          ? await mirrorComposing(db, accountId, row, provider, spoolRoot, signal)
          : false
    if (!progressed) return
  }
}
