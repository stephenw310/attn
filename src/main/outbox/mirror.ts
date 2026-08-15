import type { MailAddress } from '../../shared/address'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { encodeDraftMessage } from './draftMime'

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
  local_revision: number
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function nextPending(db: Db, accountId: string): DraftMirrorRow | undefined {
  return db
    .prepare(
      `SELECT id, state, gmail_draft_id, to_json, cc_json, bcc_json, subject, body_html,
              body_text, attachments_json, local_revision
       FROM outbox
       WHERE account_id = ? AND (
         state = 'discarding' OR
         (state IN ('composing', 'drafted') AND local_revision > mirror_revision AND NOT (
           to_json = '[]' AND cc_json = '[]' AND bcc_json = '[]' AND subject = '' AND
           body_text = '' AND attachments_json = '[]'
         ))
       )
       ORDER BY CASE state WHEN 'discarding' THEN 0 ELSE 1 END, updated_at
       LIMIT 1`
    )
    .get(accountId) as DraftMirrorRow | undefined
}

export async function saveDraftCheckpoint(
  provider: Pick<MailActionProvider, 'saveDraft'>,
  id: string | null,
  raw: string,
  onRemoteMissing: () => boolean
): Promise<string | null> {
  if (!provider.saveDraft) return null
  try {
    return await provider.saveDraft({ id, raw })
  } catch (error) {
    if (!(id && error instanceof GmailApiError && error.status === 404)) throw error
    if (!onRemoteMissing()) return null
    return provider.saveDraft({ id: null, raw })
  }
}

export async function deleteDraftCheckpoint(
  provider: Pick<MailActionProvider, 'deleteDraft'>,
  id: string
): Promise<boolean> {
  if (!provider.deleteDraft) return false
  try {
    await provider.deleteDraft(id)
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404)) throw error
  }
  return true
}

async function mirrorComposing(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: MailActionProvider
): Promise<boolean> {
  if (!provider.saveDraft) return false
  const raw = encodeDraftMessage({
    to: parseJson<MailAddress[]>(row.to_json),
    cc: parseJson<MailAddress[]>(row.cc_json),
    bcc: parseJson<MailAddress[]>(row.bcc_json),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text
  })
  const gmailDraftId = await saveDraftCheckpoint(provider, row.gmail_draft_id, raw, () => {
    db.prepare(
      `UPDATE outbox SET gmail_draft_id = NULL, mirror_revision = 0
       WHERE account_id = ? AND id = ? AND gmail_draft_id = ?`
    ).run(accountId, row.id, row.gmail_draft_id)
    const current = db
      .prepare('SELECT state FROM outbox WHERE account_id = ? AND id = ?')
      .get(accountId, row.id) as { state: string } | undefined
    return current?.state === 'composing' || current?.state === 'drafted'
  })
  if (!gmailDraftId) return false
  db.prepare(
    `UPDATE outbox SET gmail_draft_id = ?,
       mirror_revision = CASE WHEN state IN ('composing', 'drafted') THEN ? ELSE mirror_revision END
     WHERE account_id = ? AND id = ?`
  ).run(gmailDraftId, row.local_revision, accountId, row.id)
  return true
}

async function deleteDiscarded(
  db: Db,
  accountId: string,
  row: DraftMirrorRow,
  provider: MailActionProvider | null
): Promise<boolean> {
  if (row.gmail_draft_id) {
    if (!provider || !(await deleteDraftCheckpoint(provider, row.gmail_draft_id))) return false
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
  shouldContinue: () => boolean = () => true
): Promise<void> {
  while (shouldContinue()) {
    const row = nextPending(db, accountId)
    if (!row) return
    const progressed =
      row.state === 'discarding'
        ? await deleteDiscarded(db, accountId, row, provider)
        : provider
          ? await mirrorComposing(db, accountId, row, provider)
          : false
    if (!progressed) return
  }
}
