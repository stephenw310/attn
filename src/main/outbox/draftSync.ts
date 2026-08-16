import { createHash, randomUUID } from 'node:crypto'
import type { MailAddress } from '../../shared/address'
import type { DraftKind, DraftSaveInput } from '../../shared/drafts'
import type { Db } from '../db'
import {
  collectAttachments,
  decodeBase64Url,
  extractBodyHtml,
  extractBodyText,
  extractThreadingHeaders,
  findExternalTextParts,
  hasInlinePlainText,
  header,
  parseAddressList,
  parseMessageIds
} from '../gmail/parse'
import { mergeExternalBodies } from '../sync/mergeBodies'
import type { MailProvider, ProviderDraft } from '../sync/provider'
import {
  draftAttachmentsForMirror,
  parseStoredDraftAttachments,
  type StoredDraftAttachment
} from './draftAttachments'
import { draftHtmlBody } from './draftMime'

export type DraftConflictDecision = 'defer' | 'local' | 'remote'

export interface DraftConflictInput {
  state: 'composing' | 'drafted'
  localRevision: number
  mirrorRevision: number
  localUpdatedAt: number
  remoteUpdatedAt: number
  remoteChanged: boolean
}

/** Pure three-way merge rule: open wins, revision pair beats clocks, clocks break true conflicts. */
export function planDraftConflict(input: DraftConflictInput): DraftConflictDecision {
  if (input.state === 'composing') return 'defer'
  if (!input.remoteChanged) return 'local'
  if (input.localRevision === input.mirrorRevision) return 'remote'
  return input.remoteUpdatedAt >= input.localUpdatedAt ? 'remote' : 'local'
}

type FingerprintDraft = Pick<
  DraftSaveInput,
  | 'to'
  | 'cc'
  | 'bcc'
  | 'subject'
  | 'bodyHtml'
  | 'bodyText'
  | 'attachments'
  | 'threadId'
  | 'inReplyTo'
  | 'references'
  | 'quoteHtml'
  | 'quoteText'
>

export function draftContentFingerprint(draft: FingerprintDraft): string {
  const semantic = {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyHtml: draftHtmlBody(draft),
    attachments: draft.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      contentId: attachment.contentId ?? null,
      inline: attachment.inline ?? false
    })),
    threadId: draft.threadId,
    inReplyTo: draft.inReplyTo,
    references: draft.references
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

interface LocalSyncRow {
  id: string
  state: 'composing' | 'drafted'
  kind: DraftKind
  local_revision: number
  mirror_revision: number
  updated_at: number
  remote_fingerprint: string | null
  attachments_json: string
  matchedCurrentContent?: boolean
}

interface UnboundLocalSyncRow extends LocalSyncRow {
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_html: string
  body_text: string
  thread_id: string
  in_reply_to: string | null
  references_json: string
  quote_html: string
  quote_text: string
}

export interface ParsedRemoteDraft {
  input: DraftSaveInput
  storedAttachments: StoredDraftAttachment[]
  gmailDraftId: string
  gmailMessageId: string
  updatedAt: number
  fingerprint: string
}

/**
 * Draft sync must not import a Gmail draft that is already owned by the send
 * state machine. The RFC id clause also claims the one residual create-before-
 * persist crash window without manufacturing a second local draft row.
 */
function claimNonEditableOutboxDraft(db: Db, accountId: string, remote: ProviderDraft): boolean {
  const rfcMessageId = header(remote.message, 'Message-ID').trim()
  return (
    db
      .prepare(
        `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?
         WHERE account_id = ? AND state NOT IN ('composing', 'drafted') AND (
           gmail_draft_id = ? OR
           (? <> '' AND gmail_draft_id IS NULL AND rfc_message_id = ?)
         )`
      )
      .run(remote.id, remote.message.id, accountId, remote.id, rfcMessageId, rfcMessageId).changes > 0
  )
}

export function remoteDraftKind(remote: ProviderDraft, localKind?: DraftKind): DraftKind {
  if (localKind) return localKind
  if (header(remote.message, 'In-Reply-To') || header(remote.message, 'References')) return 'reply'
  return 'new'
}

async function remoteDraftBodies(
  remote: ProviderDraft,
  provider: Pick<MailProvider, 'getAttachmentData'> | null
): Promise<{ bodyHtml: string; bodyText: string }> {
  const payload = remote.message.payload
  const inlineHtml = extractBodyHtml(payload)
  const inlineText = extractBodyText(payload)
  const external = findExternalTextParts(payload)
  if (external.length === 0 || !provider) return { bodyHtml: inlineHtml, bodyText: inlineText }

  const fetchedPlain: string[] = []
  const fetchedHtml: string[] = []
  for (const part of external) {
    const data = await provider.getAttachmentData(remote.message.id, part.attachmentId)
    if (!data) continue
    const raw = decodeBase64Url(data)
    if (!raw) continue
    if (part.mimeType === 'text/html') fetchedHtml.push(raw)
    else fetchedPlain.push(raw)
  }
  const merged = mergeExternalBodies({
    storedText: inlineText || null,
    storedHtml: inlineHtml || null,
    inlineText,
    hasInlinePlain: hasInlinePlainText(payload),
    fetchedPlain,
    fetchedHtml
  })
  return { bodyHtml: merged.bodyHtml ?? '', bodyText: merged.bodyText ?? '' }
}

export async function parseRemoteDraft(
  db: Db,
  accountId: string,
  remote: ProviderDraft,
  provider: Pick<MailProvider, 'getAttachmentData'> | null,
  now: number
): Promise<ParsedRemoteDraft> {
  const message = remote.message
  const localHint = db
    .prepare(
      `SELECT kind, thread_id FROM outbox
       WHERE account_id = ? AND gmail_draft_id = ? AND state IN ('composing', 'drafted')`
    )
    .get(accountId, remote.id) as { kind: DraftKind; thread_id: string | null } | undefined
  const kind = remoteDraftKind(remote, localHint?.kind)
  const knownThread = db
    .prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, message.threadId)
  const threading = extractThreadingHeaders(message)
  const bodies = await remoteDraftBodies(remote, provider)
  const attachments: StoredDraftAttachment[] = collectAttachments(message.payload).map((attachment) => ({
    id: randomUUID(),
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    spoolPath: '',
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    ...(attachment.inline ? { inline: true } : {}),
    remoteMessageId: message.id,
    remoteAttachmentId: attachment.attachmentId,
    ...(attachment.inlineData ? { remoteInlineData: attachment.inlineData } : {})
  }))
  const input: DraftSaveInput = {
    id: null,
    kind,
    to: parseAddressList(header(message, 'To')),
    cc: parseAddressList(header(message, 'Cc')),
    bcc: parseAddressList(header(message, 'Bcc')),
    subject: header(message, 'Subject'),
    bodyHtml: bodies.bodyHtml,
    bodyText: bodies.bodyText,
    attachments,
    threadId: localHint?.thread_id ?? (kind === 'new' || !knownThread ? null : message.threadId),
    sourceMessageId: null,
    inReplyTo: parseMessageIds(header(message, 'In-Reply-To'))[0] ?? null,
    references: threading.references,
    quoteHtml: '',
    quoteText: ''
  }
  return {
    input,
    storedAttachments: attachments,
    gmailDraftId: remote.id,
    gmailMessageId: message.id,
    updatedAt: Number(message.internalDate ?? 0) || now,
    fingerprint: draftContentFingerprint(input)
  }
}

function findLocalRow(db: Db, accountId: string, remote: ParsedRemoteDraft): LocalSyncRow | undefined {
  const byId = db
    .prepare(
      `SELECT id, state, kind, local_revision, mirror_revision, updated_at, remote_fingerprint,
              attachments_json
       FROM outbox WHERE account_id = ? AND gmail_draft_id = ? AND state IN ('composing', 'drafted')`
    )
    .get(accountId, remote.gmailDraftId) as LocalSyncRow | undefined
  if (byId || remote.input.threadId === null || remote.input.kind === 'new') return byId
  const kinds = remote.input.kind === 'forward' ? ['forward'] : ['reply', 'replyAll']
  const candidates = db
    .prepare(
      `SELECT id, state, kind, local_revision, mirror_revision, updated_at, remote_fingerprint,
              to_json, cc_json, bcc_json, subject, body_html, body_text, attachments_json, thread_id,
              in_reply_to, references_json, quote_html, quote_text
       FROM outbox WHERE account_id = ? AND thread_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})
         AND gmail_draft_id IS NULL AND state IN ('composing', 'drafted') ORDER BY updated_at DESC`
    )
    .all(accountId, remote.input.threadId, ...kinds) as UnboundLocalSyncRow[]
  const matched = candidates.find(
    (candidate) =>
      draftContentFingerprint({
        to: JSON.parse(candidate.to_json) as MailAddress[],
        cc: JSON.parse(candidate.cc_json) as MailAddress[],
        bcc: JSON.parse(candidate.bcc_json) as MailAddress[],
        subject: candidate.subject,
        bodyHtml: candidate.body_html,
        bodyText: candidate.body_text,
        attachments: draftAttachmentsForMirror(parseStoredDraftAttachments(candidate.attachments_json)),
        threadId: candidate.thread_id,
        inReplyTo: candidate.in_reply_to,
        references: JSON.parse(candidate.references_json) as string[],
        quoteHtml: candidate.quote_html,
        quoteText: candidate.quote_text
      }) === remote.fingerprint
  )
  return matched ? { ...matched, matchedCurrentContent: true } : undefined
}

export function mergeRemoteDraftAttachments(
  remote: readonly StoredDraftAttachment[],
  localStored?: string
): StoredDraftAttachment[] {
  if (!localStored) return [...remote]
  const localOnlyAttachments = parseStoredDraftAttachments(localStored).filter(
    (attachment) => Boolean(attachment.spoolPath) && !attachment.inline
  )
  return [...remote, ...localOnlyAttachments]
}

function writeRemoteDraft(
  db: Db,
  accountId: string,
  remote: ParsedRemoteDraft,
  local: LocalSyncRow | undefined
): void {
  const input = remote.input
  const id = local?.id ?? randomUUID()
  const revision = Math.max(local?.local_revision ?? 0, local?.mirror_revision ?? 0) + 1
  const storedAttachments = mergeRemoteDraftAttachments(remote.storedAttachments, local?.attachments_json)
  db.prepare(
    `INSERT INTO outbox (
       id, account_id, gmail_draft_id, gmail_message_id, state, kind, to_json, cc_json, bcc_json,
       subject, body_html, body_text, attachments_json, thread_id, source_message_id, in_reply_to,
       references_json, quote_html, quote_text, created_at, updated_at, local_revision, mirror_revision,
       remote_updated_at, remote_fingerprint
     ) VALUES (?, ?, ?, ?, 'drafted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       gmail_draft_id = excluded.gmail_draft_id,
       gmail_message_id = excluded.gmail_message_id,
       state = 'drafted', kind = excluded.kind, to_json = excluded.to_json, cc_json = excluded.cc_json,
       bcc_json = excluded.bcc_json, subject = excluded.subject, body_html = excluded.body_html,
       body_text = excluded.body_text, attachments_json = excluded.attachments_json,
       thread_id = excluded.thread_id, source_message_id = excluded.source_message_id,
       in_reply_to = excluded.in_reply_to, references_json = excluded.references_json,
       quote_html = excluded.quote_html, quote_text = excluded.quote_text,
       updated_at = excluded.updated_at, local_revision = excluded.local_revision,
       mirror_revision = excluded.mirror_revision, remote_updated_at = excluded.remote_updated_at,
       remote_fingerprint = excluded.remote_fingerprint`
  ).run(
    id,
    accountId,
    remote.gmailDraftId,
    remote.gmailMessageId,
    input.kind,
    JSON.stringify(input.to),
    JSON.stringify(input.cc),
    JSON.stringify(input.bcc),
    input.subject,
    input.bodyHtml,
    input.bodyText,
    JSON.stringify(storedAttachments),
    input.threadId,
    input.sourceMessageId,
    input.inReplyTo,
    JSON.stringify(input.references),
    input.quoteHtml,
    input.quoteText,
    local?.updated_at ?? remote.updatedAt,
    remote.updatedAt,
    revision,
    revision,
    remote.updatedAt,
    remote.fingerprint
  )
}

function attachmentLocatorIdentity(attachment: StoredDraftAttachment): string {
  return JSON.stringify([
    attachment.filename,
    attachment.mimeType,
    attachment.sizeBytes,
    attachment.contentId ?? null,
    attachment.inline ?? false
  ])
}

export function refreshRemoteAttachmentLocators(
  stored: string,
  remote: readonly StoredDraftAttachment[]
): string {
  const local = parseStoredDraftAttachments(stored)
  const mirrored = draftAttachmentsForMirror(local)
  if (mirrored.length !== remote.length) return stored
  const remoteByIdentity = new Map<string, StoredDraftAttachment[]>()
  for (const attachment of remote) {
    const identity = attachmentLocatorIdentity(attachment)
    const matches = remoteByIdentity.get(identity)
    if (matches) matches.push(attachment)
    else remoteByIdentity.set(identity, [attachment])
  }
  const replacements = new Map<number, StoredDraftAttachment>()
  for (const [index, attachment] of local.entries()) {
    if (!attachment.inline && attachment.spoolPath) continue
    const matches = remoteByIdentity.get(attachmentLocatorIdentity(attachment))
    const replacement = matches?.shift()
    if (!replacement) return stored
    replacements.set(index, replacement)
  }
  if ([...remoteByIdentity.values()].some((matches) => matches.length > 0)) return stored
  return JSON.stringify(
    local.map((attachment, index) => {
      // Regular spooled files deliberately do not exist in Gmail until the
      // final send update. Preserve them without letting their presence stop
      // locator refresh for the remote/inline parts that were mirrored.
      const replacement = replacements.get(index)
      if (!replacement) return attachment
      const {
        remoteMessageId: _remoteMessageId,
        remoteAttachmentId: _remoteAttachmentId,
        remoteInlineData: _remoteInlineData,
        ...owned
      } = attachment
      return {
        ...owned,
        ...(replacement.remoteMessageId !== undefined
          ? { remoteMessageId: replacement.remoteMessageId }
          : {}),
        ...(replacement.remoteAttachmentId !== undefined
          ? { remoteAttachmentId: replacement.remoteAttachmentId }
          : {}),
        ...(replacement.remoteInlineData !== undefined
          ? { remoteInlineData: replacement.remoteInlineData }
          : {})
      }
    })
  )
}

/** Reconcile one fetched Gmail draft without ever rewriting an open composer. */
export async function reconcileRemoteDraft(
  db: Db,
  accountId: string,
  value: ProviderDraft,
  provider: Pick<MailProvider, 'getAttachmentData'> | null = null,
  now = Date.now()
): Promise<DraftConflictDecision> {
  if (claimNonEditableOutboxDraft(db, accountId, value)) return 'local'
  const remote = await parseRemoteDraft(db, accountId, value, provider, now)
  const local = findLocalRow(db, accountId, remote)
  if (!local) {
    writeRemoteDraft(db, accountId, remote, undefined)
    return 'remote'
  }
  if (local.matchedCurrentContent) {
    const attachments = refreshRemoteAttachmentLocators(local.attachments_json, remote.storedAttachments)
    db.prepare(
      `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?, mirror_revision = local_revision,
       attachments_json = ?, remote_updated_at = ?, remote_fingerprint = ?
       WHERE account_id = ? AND id = ?`
    ).run(
      remote.gmailDraftId,
      remote.gmailMessageId,
      attachments,
      remote.updatedAt,
      remote.fingerprint,
      accountId,
      local.id
    )
    return 'local'
  }
  const decision = planDraftConflict({
    state: local.state,
    localRevision: local.local_revision,
    mirrorRevision: local.mirror_revision,
    localUpdatedAt: local.updated_at,
    remoteUpdatedAt: remote.updatedAt,
    remoteChanged: local.remote_fingerprint !== remote.fingerprint
  })
  if (decision === 'remote') writeRemoteDraft(db, accountId, remote, local)
  else if (decision === 'local' && local.remote_fingerprint === remote.fingerprint) {
    const attachments = refreshRemoteAttachmentLocators(local.attachments_json, remote.storedAttachments)
    db.prepare(
      `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?, attachments_json = ?, remote_updated_at = ?
       WHERE account_id = ? AND id = ?`
    ).run(remote.gmailDraftId, remote.gmailMessageId, attachments, remote.updatedAt, accountId, local.id)
  }
  return decision
}

export async function syncRemoteDrafts(db: Db, accountId: string, provider: MailProvider): Promise<boolean> {
  const knownDrafts = new Map(
    (
      db
        .prepare(
          `SELECT gmail_draft_id, gmail_message_id, state FROM outbox
           WHERE account_id = ? AND gmail_draft_id IS NOT NULL
             AND state IN ('composing', 'drafted', 'discarding', 'queued', 'sending', 'failed',
                           'needs-review')`
        )
        .all(accountId) as { gmail_draft_id: string; gmail_message_id: string | null; state: string }[]
    ).map((row) => [
      row.gmail_draft_id,
      { gmailMessageId: row.gmail_message_id, editable: row.state === 'composing' || row.state === 'drafted' }
    ])
  )
  const remoteIds = new Set<string>()
  let pageToken: string | undefined
  let changed = false
  do {
    const page = await provider.listDrafts(pageToken)
    for (const summary of page.drafts) {
      remoteIds.add(summary.id)
      const known = knownDrafts.get(summary.id)
      if (known && !known.editable) continue
      if (summary.messageId && known?.gmailMessageId === summary.messageId) continue
      const decision = await reconcileRemoteDraft(
        db,
        accountId,
        await provider.getDraft(summary.id),
        provider
      )
      changed ||= decision === 'remote'
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  const missing = db
    .prepare(
      `SELECT id, state, gmail_draft_id, local_revision, mirror_revision FROM outbox
       WHERE account_id = ? AND gmail_draft_id IS NOT NULL AND state IN ('composing', 'drafted')`
    )
    .all(accountId) as {
    id: string
    state: 'composing' | 'drafted'
    gmail_draft_id: string
    local_revision: number
    mirror_revision: number
  }[]
  for (const row of missing) {
    if (remoteIds.has(row.gmail_draft_id)) continue
    if (row.state === 'composing' || row.local_revision > row.mirror_revision) {
      db.prepare(
        `UPDATE outbox SET gmail_draft_id = NULL, gmail_message_id = NULL, mirror_revision = 0,
         remote_fingerprint = NULL, remote_updated_at = NULL WHERE account_id = ? AND id = ?`
      ).run(accountId, row.id)
    } else {
      db.prepare('DELETE FROM outbox WHERE account_id = ? AND id = ?').run(accountId, row.id)
      changed = true
    }
  }
  return changed
}
