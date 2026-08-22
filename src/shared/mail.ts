import type { MailAddress } from './address'

export type { MailAddress } from './address'
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
  hasDraft: boolean
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
  /** MIME body resource referenced by the message HTML, not a user-visible file attachment. */
  inline?: boolean
}

export type MessageBodyState = 'complete' | 'loading' | 'signed-out' | 'unavailable'

export interface ConversationMsg {
  id: string
  /** Local outbox projection shown before Gmail returns the confirmed message. */
  pending?: boolean
  /** RFC Message-ID header, including angle brackets. */
  rfcMessageId: string | null
  /** Canonical RFC message ids from References, or In-Reply-To as a fallback. */
  references: string[]
  fromName: string
  fromEmail: string
  at: number
  recipients: MessageRecipients
  attachments: MessageAttachment[]
  /** Plain-text fallback, rendered strictly as a text node. */
  bodyText: string
  /** Raw cached mail HTML. Untrusted until sanitized by the renderer. */
  bodyHtml: string | null
  /** Whether the displayed body is complete or only a snippet awaiting hydration. */
  bodyState: MessageBodyState
}

export interface Conversation {
  threadId: string
  subject: string
  messages: ConversationMsg[]
}

/** Mailboxes whose membership and reader contents depend on per-message labels. */
export type MessageMailbox = 'all-mail' | 'spam' | 'trash'

/** The ordinary reader hides junk; mailbox readers show only their matching messages. */
export type ConversationMailbox = 'normal' | MessageMailbox

/** The per-message visibility rule shared by readers and stored thread summaries. */
export function messageLabelsMatchMailbox(
  labels: ReadonlySet<string>,
  mailbox: ConversationMailbox
): boolean {
  if (labels.has('DRAFT') || labels.has('CHAT')) return false
  if (mailbox === 'spam') return labels.has('SPAM')
  if (mailbox === 'trash') return labels.has('TRASH')
  return !labels.has('SPAM') && !labels.has('TRASH')
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

export interface InlineImageRepairRequest {
  threadId: string
}

export type SyncStage = 'metadata' | 'bodies' | 'drafts' | 'all-mail' | 'spam' | 'trash' | 'reconcile'

export type SyncState =
  | { phase: 'idle' }
  // An incremental history poll, not a staged backfill: no stage, no progress.
  | { phase: 'checking' }
  | {
      phase: 'syncing'
      stage: SyncStage
      /** Cumulative work across the staged bootstrap. */
      threadsDone: number
      /** Measurement fields consumed by the future utility-process protocol. */
      stageThreadsListed?: number
      stageThreadsFetched?: number
      stageThreadsEstimate?: number
      elapsedMs?: number
      stageElapsedMs?: number
      threadsPerMinute?: number
      stageListedPerMinute?: number
      stageFetchedPerMinute?: number
      quotaWaitMs?: number
      firstReadableMs?: number
      interactiveReadyMs?: number
    }
  | {
      phase: 'indexing'
      // 'lifetime' walks account headers; 'attachments' is the short ids-only
      // tail that flags which stored threads carry an attachment (SPEC §9 #18c).
      stage: 'lifetime' | 'attachments'
      threadsDone: number
      threadsTotal?: number
      messagesTotal?: number
      etaMs?: number
      elapsedMs?: number
      threadsPerMinute?: number
      quotaWaitMs?: number
      reason: 'running' | 'quota-wait' | 'foreground-yield' | 'retry-wait' | 'paused'
      waitMs?: number
      message?: string
    }
  | { phase: 'offline'; message: string }
  | { phase: 'error'; message: string }
