import type { MailAddress } from './address'

export interface Draft {
  id: string
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  attachments: DraftAttachment[]
  threadId: string | null
  inReplyTo: string | null
  references: string[]
  createdAt: number
  updatedAt: number
}

export interface DraftAttachment {
  filename: string
  mimeType: string
  sizeBytes: number
  spoolPath: string
}

export interface DraftSaveInput extends Omit<Draft, 'id' | 'createdAt' | 'updatedAt'> {
  id: string | null
}

export function emptyDraftInput(): DraftSaveInput {
  return {
    id: null,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    bodyHtml: '',
    bodyText: '',
    attachments: [],
    threadId: null,
    inReplyTo: null,
    references: []
  }
}
