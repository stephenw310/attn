import type { MailAddress } from '../../shared/address'
import type { DraftKind, DraftSaveInput } from '../../shared/drafts'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './draftAttachments'

/**
 * The stored columns every read of a draft's content needs, and the one place
 * they are turned back into objects. Five call sites used to parse these rows
 * inline with a local `parseJson` (review R13/REF-4), which is how the shapes
 * drifted apart in the first place.
 */
export interface OutboxContentRow {
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
}

export interface OutboxDraftRow extends OutboxContentRow {
  id: string
  kind: DraftKind
  source_message_id: string | null
  follow_up_at?: number | null
}

/** Authored content, with attachments as the main-process-owned stored shape. */
export interface OutboxDraftContent {
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  attachments: StoredDraftAttachment[]
  threadId: string | null
  inReplyTo: string | null
  references: string[]
  quoteHtml: string
  quoteText: string
}

export function outboxAddresses(value: string): MailAddress[] {
  return JSON.parse(value) as MailAddress[]
}

export function outboxReferences(value: string): string[] {
  return JSON.parse(value) as string[]
}

export function outboxDraftContent(row: OutboxContentRow): OutboxDraftContent {
  return {
    to: outboxAddresses(row.to_json),
    cc: outboxAddresses(row.cc_json),
    bcc: outboxAddresses(row.bcc_json),
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    attachments: parseStoredDraftAttachments(row.attachments_json),
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    references: outboxReferences(row.references_json),
    quoteHtml: row.quote_html,
    quoteText: row.quote_text
  }
}

/** The same content as the shape the composer, mirror gate and save path share. */
export function outboxDraftInput(row: OutboxDraftRow): DraftSaveInput {
  return {
    ...outboxDraftContent(row),
    id: row.id,
    kind: row.kind,
    sourceMessageId: row.source_message_id,
    followUpAt: row.follow_up_at ?? null
  }
}
