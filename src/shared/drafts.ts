import type { MailAddress } from './address'

export type DraftKind = 'new' | 'reply' | 'replyAll' | 'forward'

export interface Draft {
  id: string
  /**
   * The owning account (F18/F6): bound at open — the account active when a
   * new draft was created, the source thread's owner for replies/forwards —
   * and never rebound. The composer's From renders this, not whatever account
   * happens to be active.
   */
  accountId: string
  kind: DraftKind
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  attachments: DraftAttachment[]
  threadId: string | null
  sourceMessageId: string | null
  inReplyTo: string | null
  references: string[]
  quoteHtml: string
  quoteText: string
  /**
   * "Remind me if no reply" deadline (T35/F9), chosen at compose. It rides
   * the outbox row; the reminder itself is created at the sent transition.
   */
  followUpAt: number | null
  createdAt: number
  updatedAt: number
}

export interface DraftAttachment {
  /** Opaque identity assigned by the main process; never a filesystem path. */
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  contentId?: string
  inline?: boolean
}

export interface DraftInlineImageInput {
  filename: string
  mimeType: string
  dataBase64: string
}

export interface DraftInlineImageResult {
  attachment: DraftAttachment
  dataUrl: string
}

export interface DraftAttachmentMutationResult {
  attachments: DraftAttachment[]
  changed: boolean
}

// The account is never the renderer's to choose: saves bind to the active
// account in the main process, and an update whose draft row belongs to another
// account matches zero rows and fails loudly ('draft is unavailable') rather
// than rebinding — the composer blocks account switches while open, so that
// mismatch never happens in normal use (F6/F18).
export interface DraftSaveInput extends Omit<Draft, 'id' | 'accountId' | 'createdAt' | 'updatedAt'> {
  id: string | null
}

export function emptyDraftInput(): DraftSaveInput {
  return {
    id: null,
    kind: 'new',
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    bodyHtml: '',
    bodyText: '',
    attachments: [],
    threadId: null,
    sourceMessageId: null,
    inReplyTo: null,
    references: [],
    quoteHtml: '',
    quoteText: '',
    followUpAt: null
  }
}
