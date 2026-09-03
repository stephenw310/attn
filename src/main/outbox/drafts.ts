import { randomUUID } from 'node:crypto'
import { type MailAddress, normalizeEmailKey } from '../../shared/address'
import type { Draft, DraftKind, DraftSaveInput } from '../../shared/drafts'
import type { Db } from '../db'
import { parseStoredDraftAttachments, publicDraftAttachments } from './draftAttachments'
import { hasOnlyDefaultPrimarySignature } from './sendAs'

export interface DraftRow {
  id: string
  account_id: string
  gmail_draft_id: string | null
  state: 'composing' | 'drafted' | 'discarding'
  kind: DraftKind
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_html: string
  body_text: string
  attachments_json: string
  thread_id: string | null
  source_message_id: string | null
  in_reply_to: string | null
  references_json: string
  quote_html: string
  quote_text: string
  follow_up_at: number | null
  created_at: number
  updated_at: number
  local_revision: number
  default_signature_fingerprint: string | null
}

const DRAFT_COLUMNS = `id, account_id, gmail_draft_id, state, kind, to_json, cc_json,
  bcc_json, subject, body_html, body_text, attachments_json, thread_id, source_message_id, in_reply_to,
  references_json, quote_html, quote_text, follow_up_at, created_at, updated_at, local_revision,
  default_signature_fingerprint`

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

export function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    to: parseJson<MailAddress[]>(row.to_json),
    cc: parseJson<MailAddress[]>(row.cc_json),
    bcc: parseJson<MailAddress[]>(row.bcc_json),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    attachments: publicDraftAttachments(parseStoredDraftAttachments(row.attachments_json)),
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    inReplyTo: row.in_reply_to,
    references: parseJson<string[]>(row.references_json),
    quoteHtml: row.quote_html,
    quoteText: row.quote_text,
    followUpAt: row.follow_up_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Attachment bytes and locators are owned by main-process mutation paths. A
 * renderer save may carry display metadata, but it can neither invent a path
 * nor silently drop an attachment through a stale autosave snapshot.
 */
export function canonicalizeRendererDraft(db: Db, accountId: string, input: DraftSaveInput): DraftSaveInput {
  if (input.id === null) {
    if (input.attachments.length > 0)
      throw new Error('new draft attachments must be added through the bridge')
    return input
  }
  const row = db
    .prepare(
      `SELECT attachments_json FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, input.id) as { attachments_json: string } | undefined
  if (!row) throw new Error('draft is unavailable')
  return { ...input, attachments: parseStoredDraftAttachments(row.attachments_json) }
}

export function getDraft(db: Db, accountId: string, id: string): Draft | null {
  const row = db
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, id) as DraftRow | undefined
  return row ? toDraft(row) : null
}

export function listDrafts(db: Db, accountId: string): Draft[] {
  const rows = db
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM outbox
       WHERE account_id = ? AND state IN ('composing', 'drafted')
         AND NOT (
           to_json = '[]' AND cc_json = '[]' AND bcc_json = '[]' AND subject = '' AND
           body_html = '' AND body_text = '' AND attachments_json = '[]' AND quote_html = '' AND
           quote_text = ''
         )
       ORDER BY updated_at DESC, created_at DESC, id`
    )
    .all(accountId) as DraftRow[]
  return rows
    .filter((row) => !isEffectivelyEmptyDraft(toDraft(row), row.default_signature_fingerprint))
    .map(toDraft)
}

export function reopenDraft(db: Db, accountId: string, id: string, now = Date.now()): Draft | null {
  db.prepare(
    `UPDATE outbox SET state = 'composing', updated_at = ?
       WHERE account_id = ? AND id = ? AND state = 'drafted'`
  ).run(now, accountId, id)
  return getDraft(db, accountId, id)
}

export function reopenThreadDraft(
  db: Db,
  accountId: string,
  threadId: string,
  kind: Exclude<DraftKind, 'new'>,
  sourceMessageId?: string,
  now = Date.now()
): Draft | null {
  const group = kind === 'forward' ? ['forward'] : ['reply', 'replyAll']
  const placeholders = group.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT id FROM outbox
       WHERE account_id = ? AND thread_id = ? AND kind IN (${placeholders})
         ${sourceMessageId === undefined ? '' : 'AND source_message_id = ?'}
         AND state IN ('composing', 'drafted')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(accountId, threadId, ...group, ...(sourceMessageId === undefined ? [] : [sourceMessageId])) as
    | { id: string }
    | undefined
  return row ? reopenDraft(db, accountId, row.id, now) : null
}

function addressKey(address: MailAddress): string {
  return normalizeEmailKey(address.email)
}

function mergeAddresses(
  existing: readonly MailAddress[],
  planned: readonly MailAddress[],
  excluded = new Set<string>()
): MailAddress[] {
  const merged: MailAddress[] = []
  const seen = new Set(excluded)
  for (const address of [...existing, ...planned]) {
    const key = addressKey(address)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(address)
  }
  return merged
}

/** Upgrade the shared reply slot without overwriting authored content or manually added recipients. */
export function upgradeReplyToReplyAll(
  db: Db,
  accountId: string,
  id: string,
  plannedTo: readonly MailAddress[],
  plannedCc: readonly MailAddress[],
  now = Date.now()
): Draft | null {
  const row = db
    .prepare(
      `SELECT to_json, cc_json FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing' AND kind = 'reply'`
    )
    .get(accountId, id) as Pick<DraftRow, 'to_json' | 'cc_json'> | undefined
  if (!row) return getDraft(db, accountId, id)

  const to = mergeAddresses(parseJson<MailAddress[]>(row.to_json), plannedTo)
  const toEmails = new Set(to.map(addressKey))
  const cc = mergeAddresses(parseJson<MailAddress[]>(row.cc_json), plannedCc, toEmails)
  db.prepare(
    `UPDATE outbox SET kind = 'replyAll', to_json = ?, cc_json = ?, updated_at = ?,
       local_revision = local_revision + 1
     WHERE account_id = ? AND id = ? AND state = 'composing' AND kind = 'reply'`
  ).run(JSON.stringify(to), JSON.stringify(cc), now, accountId, id)
  return getDraft(db, accountId, id)
}

export function takeRecoveredDraft(db: Db, accountId: string): Draft | null {
  const row = db
    .prepare(
      `SELECT ${DRAFT_COLUMNS} FROM outbox
       WHERE account_id = ? AND state = 'composing'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(accountId) as DraftRow | undefined
  return row ? toDraft(row) : null
}

function hasAuthoredBody(draft: DraftSaveInput): boolean {
  return (
    draft.bodyText.length > 0 ||
    /<(?:img|table|hr)\b/i.test(draft.bodyHtml) ||
    draft.bodyHtml.replace(/<[^>]*>|&nbsp;|\s/gi, '').length > 0
  )
}

export function isEmptyDraft(draft: DraftSaveInput): boolean {
  return (
    draft.to.length === 0 &&
    draft.cc.length === 0 &&
    draft.bcc.length === 0 &&
    draft.subject.length === 0 &&
    !hasAuthoredBody(draft) &&
    draft.attachments.length === 0 &&
    draft.quoteHtml.length === 0 &&
    draft.quoteText.length === 0
  )
}

function isEffectivelyEmptyDraft(
  draft: DraftSaveInput,
  defaultSignatureFingerprint?: string | null
): boolean {
  if (isEmptyDraft(draft)) return true
  if (!isEmptyDraft({ ...draft, bodyHtml: '', bodyText: '' })) return false
  return hasOnlyDefaultPrimarySignature(draft, defaultSignatureFingerprint)
}

/**
 * Gmail does not keep a reply or forward the user never contributed to, and
 * neither should we — but such a draft is not blank: `planReply` fills the
 * quote, a `Re:`/`Fwd:` subject, and a reply's recipients. So test the fields
 * the plan never writes instead. It fills `to`/`cc` only for replies and never
 * fills `bcc`. Signature preparation may fill the body with the saved default.
 * Attachments marked `planned` came from the source message; ordinary attachments
 * came from the user. The marker remains main-process only and survives
 * remote-locator refreshes.
 */
export function isUntouchedThreadDraft(
  draft: DraftSaveInput,
  forwardEditedSincePlan = false,
  defaultSignatureFingerprint?: string | null
): boolean {
  if (draft.kind === 'new') return false
  return (
    !forwardEditedSincePlan &&
    (!hasAuthoredBody(draft) || hasOnlyDefaultPrimarySignature(draft, defaultSignatureFingerprint)) &&
    !draft.attachments.some(
      (attachment) => !attachment.inline && !('planned' in attachment && attachment.planned === true)
    ) &&
    draft.bcc.length === 0 &&
    (draft.kind === 'replyAll' || draft.cc.length === 0) &&
    (draft.kind !== 'forward' || draft.to.length === 0)
  )
}

/**
 * The single rule for "is this draft worth putting in Gmail": not effectively
 * empty, and not a reply or forward the user never contributed to. Every path
 * that can push a row to Gmail — the IPC checkpoint request, closing a
 * composer, and the mirror's own row selection — asks this one question, so a
 * crash-recovered untouched reply cannot reach Gmail through a drain the
 * composer never requested.
 */
export function shouldMirrorDraft(
  input: DraftSaveInput,
  localRevision: number,
  defaultSignatureFingerprint: string | null
): boolean {
  // Forward planning is the only system path that creates a removable regular
  // attachment, and it writes revision 1. Any later revision therefore means
  // the user changed the forward even if the final fields alone cannot show it
  // (most importantly, when they removed every forwarded file).
  const forwardEditedSincePlan = input.kind === 'forward' && localRevision > 1
  return (
    !isEffectivelyEmptyDraft(input, defaultSignatureFingerprint) &&
    !isUntouchedThreadDraft(input, forwardEditedSincePlan, defaultSignatureFingerprint)
  )
}

/** Create-before-type and subsequent checkpoints share one operation. Id-less always means new. */
export function saveDraft(
  db: Db,
  accountId: string,
  input: DraftSaveInput,
  now = Date.now(),
  defaultSignatureFingerprint: string | null = null
): string {
  const id = input.id ?? randomUUID()

  db.transaction(() => {
    if (input.id === null) {
      db.prepare(
        `INSERT INTO outbox (
           id, account_id, state, kind, to_json, cc_json, bcc_json, subject, body_html, body_text,
           attachments_json, thread_id, source_message_id, in_reply_to, references_json, quote_html,
           quote_text, follow_up_at, created_at, updated_at, local_revision, default_signature_fingerprint
         ) VALUES (?, ?, 'composing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        accountId,
        input.kind,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.bcc),
        input.subject,
        input.bodyHtml,
        input.bodyText,
        JSON.stringify(input.attachments),
        input.threadId,
        input.sourceMessageId,
        input.inReplyTo,
        JSON.stringify(input.references),
        input.quoteHtml,
        input.quoteText,
        input.followUpAt,
        now,
        now,
        isEffectivelyEmptyDraft(input, defaultSignatureFingerprint) ? 0 : 1,
        defaultSignatureFingerprint
      )
      return
    }

    const result = db
      .prepare(
        `UPDATE outbox SET
           kind = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, body_text = ?,
           attachments_json = ?, thread_id = ?, source_message_id = ?, in_reply_to = ?, references_json = ?,
           quote_html = ?, quote_text = ?, follow_up_at = ?,
           updated_at = ?, local_revision = local_revision + 1
         WHERE account_id = ? AND id = ? AND state = 'composing'`
      )
      .run(
        input.kind,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.bcc),
        input.subject,
        input.bodyHtml,
        input.bodyText,
        JSON.stringify(input.attachments),
        input.threadId,
        input.sourceMessageId,
        input.inReplyTo,
        JSON.stringify(input.references),
        input.quoteHtml,
        input.quoteText,
        input.followUpAt,
        now,
        accountId,
        id
      )
    if (result.changes === 0) throw new Error('draft is unavailable')
  })()
  return id
}

export function requestDraftMirror(db: Db, accountId: string, draftId: string): boolean {
  const draft = db
    .prepare(
      `SELECT to_json, cc_json, bcc_json, subject, body_html, body_text, attachments_json,
              thread_id, source_message_id, in_reply_to, references_json, kind, quote_html, quote_text,
              local_revision, default_signature_fingerprint
       FROM outbox
       WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')
         AND local_revision > mirror_revision`
    )
    .get(accountId, draftId) as
    | Pick<
        DraftRow,
        | 'to_json'
        | 'cc_json'
        | 'bcc_json'
        | 'subject'
        | 'body_html'
        | 'body_text'
        | 'attachments_json'
        | 'thread_id'
        | 'source_message_id'
        | 'in_reply_to'
        | 'references_json'
        | 'kind'
        | 'quote_html'
        | 'quote_text'
        | 'local_revision'
        | 'default_signature_fingerprint'
      >
    | undefined
  if (!draft) return false
  const input: DraftSaveInput = {
    id: draftId,
    to: parseJson<MailAddress[]>(draft.to_json),
    cc: parseJson<MailAddress[]>(draft.cc_json),
    bcc: parseJson<MailAddress[]>(draft.bcc_json),
    subject: draft.subject,
    bodyHtml: draft.body_html,
    bodyText: draft.body_text,
    attachments: parseStoredDraftAttachments(draft.attachments_json),
    threadId: draft.thread_id,
    inReplyTo: draft.in_reply_to,
    references: parseJson<string[]>(draft.references_json),
    kind: draft.kind,
    sourceMessageId: draft.source_message_id,
    quoteHtml: draft.quote_html,
    quoteText: draft.quote_text,
    followUpAt: null
  }
  return shouldMirrorDraft(input, draft.local_revision, draft.default_signature_fingerprint)
}

export function closeDraft(db: Db, accountId: string, id: string, now = Date.now()): 'saved' | 'discarded' {
  const row = db
    .prepare(`SELECT ${DRAFT_COLUMNS} FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'`)
    .get(accountId, id) as DraftRow | undefined
  if (!row) throw new Error('draft is unavailable')
  const draft = toDraft(row)
  const input: DraftSaveInput = {
    ...draft,
    id: draft.id,
    attachments: parseStoredDraftAttachments(row.attachments_json)
  }
  if (shouldMirrorDraft(input, row.local_revision, row.default_signature_fingerprint)) {
    db.prepare("UPDATE outbox SET state = 'drafted', updated_at = ? WHERE account_id = ? AND id = ?").run(
      now,
      accountId,
      id
    )
    return 'saved'
  }
  if (row.gmail_draft_id) {
    db.prepare(
      `UPDATE outbox SET state = 'discarding', to_json = '[]', cc_json = '[]', bcc_json = '[]',
       subject = '', body_html = '', body_text = '', attachments_json = '[]', thread_id = NULL,
       source_message_id = NULL, in_reply_to = NULL, references_json = '[]', quote_html = '',
       quote_text = '', updated_at = ? WHERE account_id = ? AND id = ?`
    ).run(now, accountId, id)
  } else {
    db.prepare('DELETE FROM outbox WHERE account_id = ? AND id = ?').run(accountId, id)
  }
  return 'discarded'
}

export function discardDraft(
  db: Db,
  accountId: string,
  id: string,
  expectedState: 'composing' | 'drafted' = 'composing'
): boolean {
  return (
    db
      .prepare(
        `UPDATE outbox SET state = 'discarding', to_json = '[]', cc_json = '[]', bcc_json = '[]',
       subject = '', body_html = '', body_text = '', attachments_json = '[]', thread_id = NULL,
       source_message_id = NULL, in_reply_to = NULL, references_json = '[]', quote_html = '',
       quote_text = '', updated_at = ?
     WHERE account_id = ? AND id = ? AND state = ?`
      )
      .run(Date.now(), accountId, id, expectedState).changes > 0
  )
}
