import { createHash, randomUUID } from 'node:crypto'
import type { MailAddress } from '../../shared/address'
import type { DraftKind, DraftSaveInput } from '../../shared/drafts'
import type { Db } from '../db'
import type { GmailMessage } from '../gmail/parse'
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
import type { MailProvider, ProviderDraft, ProviderRequestOptions } from '../sync/provider'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './draftAttachments'
import { draftHtmlBody, mimeFilename } from './draftMime'
import { splitQuotedTrail } from './quoteSplit'

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
      // Hash the name Gmail will echo, not the one on disk, or a non-ASCII
      // filename makes the local and remote fingerprints permanently disagree.
      filename: mimeFilename(attachment.filename),
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
  thread_id: string | null
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
  // Only a row still mid-send can own a Gmail draft it never persisted. A sent
  // row keeps its Message-ID for a week, and claiming an unrelated orphan draft
  // onto it would hide that draft from Drafts for good. Resolving the row first
  // also keeps the claim to exactly one row.
  const owner = db
    .prepare(
      `SELECT id FROM outbox
       WHERE account_id = ? AND state NOT IN ('composing', 'drafted') AND (
         gmail_draft_id = ? OR
         (? <> '' AND gmail_draft_id IS NULL AND rfc_message_id = ? AND state IN ('queued', 'sending'))
       )
       ORDER BY updated_at LIMIT 1`
    )
    .get(accountId, remote.id, rfcMessageId, rfcMessageId) as { id: string } | undefined
  if (!owner) return false
  db.prepare(
    `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?
     WHERE account_id = ? AND id = ?`
  ).run(remote.id, remote.message.id, accountId, owner.id)
  return true
}

export function remoteDraftKind(
  remote: ProviderDraft,
  localKind?: DraftKind,
  knownThread = false
): DraftKind {
  if (localKind) return localKind
  if (header(remote.message, 'In-Reply-To') || header(remote.message, 'References')) return 'reply'
  // Gmail does not expose a draft-mode flag. A draft attached to an existing
  // thread with no reply headers is a forward, regardless of the locale used
  // for its subject prefix (Fwd:, WG:, TR:, ...).
  if (knownThread) return 'forward'
  return 'new'
}

async function remoteDraftBodies(
  remote: ProviderDraft,
  provider: Pick<MailProvider, 'getAttachmentData'> | null,
  requestOptions?: ProviderRequestOptions
): Promise<{ bodyHtml: string; bodyText: string }> {
  const payload = remote.message.payload
  const inlineHtml = extractBodyHtml(payload)
  const inlineText = extractBodyText(payload)
  const external = findExternalTextParts(payload)
  if (external.length === 0 || !provider) return { bodyHtml: inlineHtml, bodyText: inlineText }

  const fetchedPlain: string[] = []
  const fetchedHtml: string[] = []
  for (const part of external) {
    const data = await provider.getAttachmentData(remote.message.id, part.attachmentId, requestOptions)
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

/**
 * Locators for one fetched Gmail message. Both ids rotate every time the draft
 * is rewritten, so these are only valid for the message they were read from.
 */
export function remoteDraftAttachments(message: GmailMessage): StoredDraftAttachment[] {
  return collectAttachments(message.payload).map((attachment) => ({
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
}

export async function parseRemoteDraft(
  db: Db,
  accountId: string,
  remote: ProviderDraft,
  provider: Pick<MailProvider, 'getAttachmentData'> | null,
  now: number,
  requestOptions?: ProviderRequestOptions
): Promise<ParsedRemoteDraft> {
  const message = remote.message
  const localHint = db
    .prepare(
      `SELECT kind, thread_id FROM outbox
       WHERE account_id = ? AND gmail_draft_id = ? AND state IN ('composing', 'drafted')`
    )
    .get(accountId, remote.id) as { kind: DraftKind; thread_id: string | null } | undefined
  const knownThread = db
    .prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?')
    .get(accountId, message.threadId)
  // A previous sync may have imported a Gmail thread draft as an unbound new
  // draft. Only preserve the local kind as an identity hint once it is already
  // bound; otherwise the authoritative Gmail thread id gets a chance to repair
  // that classification.
  const kind = remoteDraftKind(remote, localHint?.thread_id ? localHint.kind : undefined, !!knownThread)
  const threading = extractThreadingHeaders(message)
  const bodies = await remoteDraftBodies(remote, provider, requestOptions)
  const attachments = remoteDraftAttachments(message)
  // Gmail stores a draft as one document, so a reply comes back with its quoted
  // trail merged into the body. Recover the two columns, or the trail lands in
  // the editor as authored content. A `new` draft is left alone: a quote at the
  // end of one is something its author put there.
  const parts =
    kind === 'new'
      ? { bodyHtml: bodies.bodyHtml, bodyText: bodies.bodyText, quoteHtml: '', quoteText: '' }
      : splitQuotedTrail(bodies.bodyHtml, bodies.bodyText)
  const input: DraftSaveInput = {
    id: null,
    followUpAt: null,
    kind,
    to: parseAddressList(header(message, 'To')),
    cc: parseAddressList(header(message, 'Cc')),
    bcc: parseAddressList(header(message, 'Bcc')),
    subject: header(message, 'Subject'),
    bodyHtml: parts.bodyHtml,
    bodyText: parts.bodyText,
    attachments,
    threadId: localHint?.thread_id ?? (kind === 'new' || !knownThread ? null : message.threadId),
    sourceMessageId: null,
    inReplyTo: parseMessageIds(header(message, 'In-Reply-To'))[0] ?? null,
    references: threading.references,
    quoteHtml: parts.quoteHtml,
    quoteText: parts.quoteText
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
              attachments_json, thread_id
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
        attachments: parseStoredDraftAttachments(candidate.attachments_json),
        threadId: candidate.thread_id,
        inReplyTo: candidate.in_reply_to,
        references: JSON.parse(candidate.references_json) as string[],
        quoteHtml: candidate.quote_html,
        quoteText: candidate.quote_text
      }) === remote.fingerprint
  )
  return matched ? { ...matched, matchedCurrentContent: true } : undefined
}

/**
 * Now that spooled files are mirrored, Gmail echoes them back as remote-only
 * parts on the next read. Appending the local copy unconditionally would store
 * the same file twice, and the next checkpoint would upload both — doubling on
 * every round trip. Pair each echo with the local entry that produced it and
 * keep the local one: the spool is the durable source of the bytes, while
 * Gmail's attachment locators rotate on every draft rewrite.
 */
function matchesLocalAttachment(
  remote: StoredDraftAttachment,
  local: StoredDraftAttachment,
  loose: boolean
): boolean {
  if (remote.contentId && local.contentId) return remote.contentId === local.contentId
  if (remote.contentId || local.contentId) return false
  if (mimeFilename(remote.filename) !== mimeFilename(local.filename)) return false
  if (remote.mimeType !== local.mimeType) return false
  return loose || remote.sizeBytes === local.sizeBytes
}

export function mergeRemoteDraftAttachments(
  remote: readonly StoredDraftAttachment[],
  localStored?: string
): StoredDraftAttachment[] {
  if (!localStored) return [...remote]
  const spooled = parseStoredDraftAttachments(localStored).filter((attachment) =>
    Boolean(attachment.spoolPath)
  )
  const unmatched = new Set(spooled)
  const take = (candidate: StoredDraftAttachment, loose: boolean): StoredDraftAttachment | undefined => {
    for (const local of unmatched) {
      if (!matchesLocalAttachment(candidate, local, loose)) continue
      unmatched.delete(local)
      return local
    }
    return undefined
  }
  // Exact size first, so two same-named files pair with their own echo before a
  // size that Gmail reported differently is allowed to absorb one.
  const paired = remote.map((candidate) => ({ candidate, local: take(candidate, false) }))
  const merged = paired.map(({ candidate, local }) => local ?? take(candidate, true) ?? candidate)
  return [...merged, ...spooled.filter((local) => unmatched.has(local))]
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
       remote_fingerprint
     ) VALUES (?, ?, ?, ?, 'drafted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       mirror_revision = excluded.mirror_revision, remote_fingerprint = excluded.remote_fingerprint`
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
    remote.fingerprint
  )
}

function attachmentLocatorIdentity(attachment: StoredDraftAttachment): string {
  return JSON.stringify([
    // Matched across the same local/remote seam as the fingerprint, so it must
    // normalize the filename the same way.
    mimeFilename(attachment.filename),
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
  const remoteByIdentity = new Map<string, StoredDraftAttachment[]>()
  for (const attachment of remote) {
    const identity = attachmentLocatorIdentity(attachment)
    const matches = remoteByIdentity.get(identity)
    if (matches) matches.push(attachment)
    else remoteByIdentity.set(identity, [attachment])
  }
  const replacements = new Map<number, StoredDraftAttachment>()
  for (const [index, attachment] of local.entries()) {
    const spooledFile = Boolean(attachment.spoolPath) && !attachment.inline
    const replacement = remoteByIdentity.get(attachmentLocatorIdentity(attachment))?.shift()
    if (!replacement) {
      // A spooled file may simply not have reached Gmail yet, and its absence
      // must not stop the parts Gmail does hold from being refreshed. Anything
      // else missing means the two sides disagree — leave the row untouched.
      if (spooledFile) continue
      return stored
    }
    // Matched spooled files still consume their echo so the leftover check
    // below stays a real assertion, but keep the spool as the byte source:
    // Gmail's locators rotate on every rewrite, the spool does not.
    if (!spooledFile) replacements.set(index, replacement)
  }
  if ([...remoteByIdentity.values()].some((matches) => matches.length > 0)) return stored
  return JSON.stringify(
    local.map((attachment, index) => {
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
  now = Date.now(),
  requestOptions?: ProviderRequestOptions
): Promise<DraftConflictDecision> {
  if (claimNonEditableOutboxDraft(db, accountId, value)) return 'local'
  const remote = await parseRemoteDraft(db, accountId, value, provider, now, requestOptions)
  const local = findLocalRow(db, accountId, remote)
  if (!local) {
    writeRemoteDraft(db, accountId, remote, undefined)
    return 'remote'
  }
  const repairsThreadBinding =
    local.kind === 'new' &&
    local.thread_id === null &&
    remote.input.kind !== 'new' &&
    remote.input.threadId !== null
  if (repairsThreadBinding) {
    db.prepare(`UPDATE outbox SET kind = ?, thread_id = ? WHERE account_id = ? AND id = ?`).run(
      remote.input.kind,
      remote.input.threadId,
      accountId,
      local.id
    )
    local.kind = remote.input.kind
    local.thread_id = remote.input.threadId
  }
  if (local.matchedCurrentContent) {
    const attachments = refreshRemoteAttachmentLocators(local.attachments_json, remote.storedAttachments)
    db.prepare(
      `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?, mirror_revision = local_revision,
       attachments_json = ?, remote_fingerprint = ?
       WHERE account_id = ? AND id = ?`
    ).run(remote.gmailDraftId, remote.gmailMessageId, attachments, remote.fingerprint, accountId, local.id)
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
      `UPDATE outbox SET gmail_draft_id = ?, gmail_message_id = ?, attachments_json = ?
       WHERE account_id = ? AND id = ?`
    ).run(remote.gmailDraftId, remote.gmailMessageId, attachments, accountId, local.id)
  }
  return decision
}

export interface RemoteDraftSyncResult {
  changed: boolean
  /** Rows this pass deleted, so the caller can drop their attachment spool now. */
  deletedIds: string[]
}

export async function syncRemoteDrafts(
  db: Db,
  accountId: string,
  provider: MailProvider
): Promise<RemoteDraftSyncResult> {
  const knownDrafts = new Map(
    (
      db
        .prepare(
          `SELECT gmail_draft_id, gmail_message_id, state, kind, thread_id FROM outbox
           WHERE account_id = ? AND gmail_draft_id IS NOT NULL
             AND state IN ('composing', 'drafted', 'discarding', 'queued', 'sending', 'failed',
                           'needs-review')`
        )
        .all(accountId) as {
        gmail_draft_id: string
        gmail_message_id: string | null
        state: string
        kind: DraftKind
        thread_id: string | null
      }[]
    ).map((row) => [
      row.gmail_draft_id,
      {
        gmailMessageId: row.gmail_message_id,
        editable: row.state === 'composing' || row.state === 'drafted',
        kind: row.kind,
        threadId: row.thread_id
      }
    ])
  )
  const remoteIds = new Set<string>()
  const deletedIds: string[] = []
  let pageToken: string | undefined
  let changed = false
  do {
    const page = await provider.listDrafts(pageToken, { priority: 'polling' })
    for (const summary of page.drafts) {
      remoteIds.add(summary.id)
      const known = knownDrafts.get(summary.id)
      if (known && !known.editable) continue
      // A legacy row imported before thread binding existed still needs one
      // refetch to learn its parent, even though its remote summary is unchanged.
      const canRepairThreadBinding =
        known?.kind === 'new' &&
        known.threadId === null &&
        !!summary.threadId &&
        !!db.prepare('SELECT 1 FROM threads WHERE account_id = ? AND id = ?').get(accountId, summary.threadId)
      if (summary.messageId && known?.gmailMessageId === summary.messageId && !canRepairThreadBinding)
        continue
      const decision = await reconcileRemoteDraft(
        db,
        accountId,
        await provider.getDraft(summary.id, { priority: 'polling' }),
        provider,
        undefined,
        { priority: 'polling' }
      )
      changed ||= canRepairThreadBinding || decision === 'remote'
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
    // A row bound during this listing — its first mirror checkpoint returned a
    // Gmail id after `knownDrafts` was read but before the listing finished —
    // is absent from a listing that predates the create, not deleted remotely.
    // Judging it now would delete a drafted row (re-imported next cycle under a
    // new id) or, for a composing row, clear the binding so the mirror creates a
    // second Gmail draft. Leave it for the next cycle's authoritative listing.
    if (!knownDrafts.has(row.gmail_draft_id)) continue
    if (row.state === 'composing' || row.local_revision > row.mirror_revision) {
      db.prepare(
        `UPDATE outbox SET gmail_draft_id = NULL, gmail_message_id = NULL, mirror_revision = 0,
         remote_fingerprint = NULL WHERE account_id = ? AND id = ?`
      ).run(accountId, row.id)
    } else {
      db.prepare('DELETE FROM outbox WHERE account_id = ? AND id = ?').run(accountId, row.id)
      deletedIds.push(row.id)
      changed = true
    }
  }
  return { changed, deletedIds }
}
