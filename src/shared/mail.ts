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

export interface SnoozedThreadRow extends ThreadRow {
  dueAt: number
}

export interface MailLabel {
  id: string
  name: string
  type: string
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
  contentId?: string
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

export interface InlineImageRequest {
  messageId: string
  attachmentId: string
  mimeType: string
}

export type InlineImageResult = { dataUrl: string } | { error: string }

export type SyncStage = 'metadata' | 'bodies' | 'reconcile'

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'syncing'; stage: SyncStage; threadsDone: number }
  | { phase: 'offline'; message: string }
  | { phase: 'error'; message: string }
