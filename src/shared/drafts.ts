import type { MailAddress } from './address'

export type DraftKind = 'new' | 'reply' | 'replyAll' | 'forward'

export interface Draft {
  id: string
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
}

export interface DraftSaveInput extends Omit<Draft, 'id' | 'createdAt' | 'updatedAt'> {
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
    quoteText: ''
  }
}
