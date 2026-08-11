// Mail data contracts shared by main, preload, and renderer.

export interface ThreadRow {
  id: string
  fromDisplay: string
  subject: string
  snippet: string
  lastMsgAt: number
  unread: boolean
  starred: boolean
  hasAttachment: boolean
  returned: boolean
  labelIds: string[]
}

export interface MailLabel {
  id: string
  name: string
  type: string
}

export interface SnoozedThreadRow extends ThreadRow {
  dueAt: number
}

export interface MailAddress {
  name: string
  email: string
}

export interface MessageRecipients {
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  replyTo: MailAddress[]
}

export interface MessageAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface ConversationMsg {
  id: string
  fromName: string
  fromEmail: string
  at: number
  recipients: MessageRecipients
  attachments: MessageAttachment[]
  /** Plain-text fallback, rendered strictly as a text node. */
  bodyText: string
  /** Raw cached mail HTML. Untrusted until sanitized by the renderer. */
  bodyHtml: string | null
}

export interface Conversation {
  threadId: string
  subject: string
  messages: ConversationMsg[]
}

export interface DownloadAttachmentRequest {
  messageId: string
  attachmentId: string
  filename: string
}

export type DownloadAttachmentResult = { path: string } | { error: string }

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'syncing'; threadsDone: number }
  | { phase: 'error'; message: string }
