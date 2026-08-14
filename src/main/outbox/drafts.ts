import { randomUUID } from 'node:crypto'
import type { MailAddress } from '../../shared/address'
import type { Draft, DraftAttachment, DraftSaveInput } from '../../shared/drafts'
import type { Db } from '../db'
import type { MailActionProvider } from '../sync/provider'

interface DraftRow {
  id: string
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
  created_at: number
  updated_at: number
  local_revision: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    to: parseJson<MailAddress[]>(row.to_json),
    cc: parseJson<MailAddress[]>(row.cc_json),
    bcc: parseJson<MailAddress[]>(row.bcc_json),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    attachments: parseJson<DraftAttachment[]>(row.attachments_json),
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    references: parseJson<string[]>(row.references_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getDraft(db: Db, accountId: string, id: string): Draft | null {
  const row = db
    .prepare(
      `SELECT id, gmail_draft_id, to_json, cc_json, bcc_json, subject, body_html, body_text,
              attachments_json, thread_id, in_reply_to, references_json, created_at, updated_at,
              local_revision
       FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, id) as DraftRow | undefined
  return row ? toDraft(row) : null
}

export function takeRecoveredDraft(db: Db, accountId: string): Draft | null {
  const row = db
    .prepare(
      `SELECT id, gmail_draft_id, to_json, cc_json, bcc_json, subject, body_html, body_text,
              attachments_json, thread_id, in_reply_to, references_json, created_at, updated_at,
              local_revision
       FROM outbox
       WHERE account_id = ? AND state = 'composing' AND local_revision > mirror_revision
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(accountId) as DraftRow | undefined
  return row ? toDraft(row) : null
}

function isEmptyDraft(draft: DraftSaveInput): boolean {
  return (
    draft.to.length === 0 &&
    draft.cc.length === 0 &&
    draft.bcc.length === 0 &&
    draft.subject.length === 0 &&
    draft.bodyText.length === 0 &&
    draft.attachments.length === 0
  )
}

/**
 * Create-before-type and save share one operation. An id-less save first reuses
 * the account's live composing row, enforcing the one-composer v1 rule.
 */
export function saveDraft(db: Db, accountId: string, input: DraftSaveInput, now = Date.now()): string {
  if (input.id === null) {
    const live = db
      .prepare(
        `SELECT id FROM outbox
         WHERE account_id = ? AND state = 'composing'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(accountId) as { id: string } | undefined
    if (live) return live.id
  }
  const id = input.id ?? randomUUID()

  db.transaction(() => {
    if (input.id === null) {
      db.prepare(
        `INSERT INTO outbox (id, account_id, state, created_at, updated_at)
         VALUES (?, ?, 'composing', ?, ?)`
      ).run(id, accountId, now, now)
      return
    }

    const result = db
      .prepare(
        `UPDATE outbox SET
           to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_html = ?, body_text = ?,
           attachments_json = ?, thread_id = ?, in_reply_to = ?, references_json = ?,
           updated_at = ?, local_revision = local_revision + 1
         WHERE account_id = ? AND id = ? AND state = 'composing'`
      )
      .run(
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.bcc),
        input.subject,
        input.bodyHtml,
        input.bodyText,
        JSON.stringify(input.attachments),
        input.threadId,
        input.inReplyTo,
        JSON.stringify(input.references),
        now,
        accountId,
        id
      )
    if (result.changes === 0) throw new Error('draft is unavailable')
  })()
  return id
}

export function requestDraftMirror(db: Db, accountId: string, draftId: string): void {
  const draft = db
    .prepare(
      `SELECT to_json, cc_json, bcc_json, subject, body_text, attachments_json
       FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'
         AND local_revision > mirror_revision`
    )
    .get(accountId, draftId) as
    | Pick<DraftRow, 'to_json' | 'cc_json' | 'bcc_json' | 'subject' | 'body_text' | 'attachments_json'>
    | undefined
  if (
    !draft ||
    isEmptyDraft({
      id: draftId,
      to: parseJson<MailAddress[]>(draft.to_json),
      cc: parseJson<MailAddress[]>(draft.cc_json),
      bcc: parseJson<MailAddress[]>(draft.bcc_json),
      subject: draft.subject,
      bodyHtml: '',
      bodyText: draft.body_text,
      attachments: parseJson<DraftAttachment[]>(draft.attachments_json),
      threadId: null,
      inReplyTo: null,
      references: []
    })
  ) {
    return
  }
  db.prepare(
    `DELETE FROM action_queue
     WHERE account_id = ? AND kind = 'mirrorDraft' AND thread_id = ? AND state != 'inflight'`
  ).run(accountId, draftId)
  db.prepare(
    `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
     VALUES (?, 'mirrorDraft', ?, '{}', 'pending')`
  ).run(accountId, draftId)
}

export function discardDraft(db: Db, accountId: string, id: string): void {
  db.transaction(() => {
    db.prepare(
      "DELETE FROM action_queue WHERE account_id = ? AND kind = 'mirrorDraft' AND thread_id = ?"
    ).run(accountId, id)
    db.prepare("DELETE FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'").run(
      accountId,
      id
    )
  })()
}

interface DraftMirrorRow {
  gmail_draft_id: string | null
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_html: string
  body_text: string
  local_revision: number
}

/** Execute one best-effort Gmail Drafts checkpoint; send is intentionally absent. */
export async function mirrorDraft(
  db: Db,
  accountId: string,
  draftId: string,
  provider: MailActionProvider
): Promise<void> {
  if (!provider.saveDraft) throw new Error('draft mirroring is unavailable')
  const row = db
    .prepare(
      `SELECT gmail_draft_id, to_json, cc_json, bcc_json, subject, body_html, body_text,
              local_revision
       FROM outbox WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as DraftMirrorRow | undefined
  if (!row) return

  const gmailDraftId = await provider.saveDraft({
    id: row.gmail_draft_id,
    raw: encodeDraftMessage(row)
  })
  db.prepare(
    `UPDATE outbox SET gmail_draft_id = ?, mirror_revision = ?
     WHERE account_id = ? AND id = ? AND state = 'composing'`
  ).run(gmailDraftId, row.local_revision, accountId, draftId)
}

function encodeDraftMessage(row: DraftMirrorRow): string {
  const header = (name: string, value: string): string =>
    value ? `${name}: ${value.replace(/[\r\n]+/g, ' ')}` : ''
  const addresses = (value: string): string =>
    parseJson<MailAddress[]>(value)
      .map((address) =>
        address.name ? `"${address.name.replace(/["\r\n]/g, '')}" <${address.email}>` : address.email
      )
      .join(', ')
  const body = row.body_html || `<p>${escapeHtml(row.body_text).replace(/\n/g, '<br>')}</p>`
  const raw = [
    header('To', addresses(row.to_json)),
    header('Cc', addresses(row.cc_json)),
    header('Bcc', addresses(row.bcc_json)),
    header('Subject', row.subject),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    body
  ]
    .filter((line, index) => line || index >= 6)
    .join('\r\n')
  return Buffer.from(raw).toString('base64url')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
