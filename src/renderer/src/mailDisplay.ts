import type {
  Conversation,
  MessageAttachment,
  MessageBodyState,
  MessageRecipients,
  SnoozedThreadRow,
  ThreadRow
} from '../../shared/mail'
import { formatSnoozeDate } from '../../shared/snooze'

export interface DisplayThread {
  id: string
  from: string
  subject: string
  snippet: string
  at: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
  returned: boolean
  hasDraft: boolean
  dueAt?: number
  dueLabel?: string
  labelIds: string[]
  lastMsgAt: number
}

export interface DisplayMessage {
  id: string
  pending: boolean
  fromName: string
  fromEmail: string
  at: string
  fullDate: string
  recipients: MessageRecipients
  attachments: MessageAttachment[]
  text: string
  html: string | null
  bodyState: MessageBodyState
}

export interface DisplayConversation {
  threadId: string
  subject: string
  messages: DisplayMessage[]
  bodyHydrationFailed: boolean
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const now = new Date()
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (dayDiff === 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (dayDiff === 1) return 'Yesterday'
  if (dayDiff < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatFullDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  })
}

export function displayThread(row: ThreadRow): DisplayThread {
  return {
    id: row.id,
    from: row.fromDisplay || '(unknown)',
    subject: row.subject,
    snippet: row.snippet,
    at: formatTime(row.lastMsgAt),
    unread: row.unread,
    starred: row.starred,
    hasAttachment: row.hasAttachment,
    returned: row.returned,
    hasDraft: row.hasDraft,
    labelIds: row.labelIds,
    lastMsgAt: row.lastMsgAt
  }
}

export function displaySnoozedThread(row: SnoozedThreadRow): DisplayThread {
  return { ...displayThread(row), dueAt: row.dueAt, dueLabel: formatSnoozeDate(row.dueAt) }
}

export function displayConversation(conversation: Conversation): DisplayConversation {
  return {
    threadId: conversation.threadId,
    subject: conversation.subject,
    bodyHydrationFailed: false,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      pending: message.pending === true,
      fromName: message.fromName,
      fromEmail: message.fromEmail,
      at: formatTime(message.at),
      fullDate: formatFullDate(message.at),
      recipients: message.recipients,
      attachments: message.attachments,
      text: message.bodyText,
      html: message.bodyHtml,
      bodyState: message.bodyState
    }))
  }
}
