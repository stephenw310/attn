import type {
  Conversation,
  MailboxView,
  MessageAttachment,
  MessageBodyState,
  MessageRecipients,
  SnoozedThreadRow,
  ThreadRow
} from '../../shared/mail'
import { formatSnoozeDate } from '../../shared/snooze'

export type UserLabelView = `label:${string}`

/** Every view the shell can host: mailboxes, user labels, and the on-demand Outbox. */
export type MailView = MailboxView | UserLabelView | 'outbox'
export type NavigableMailView = Exclude<MailView, 'outbox'>
export type PagedThreadView = Exclude<NavigableMailView, 'drafts'>

/** Mailbox views whose rows come from the label-driven listMailboxThreads read. */
export type LabelMailboxView = Exclude<MailboxView, 'inbox' | 'drafts' | 'snoozed'>

/** Views whose ordinary thread rows are cached independently by the renderer. */
export type CachedThreadView = LabelMailboxView | UserLabelView

export function labelMailboxView(view: MailView): LabelMailboxView | null {
  return view === 'allMail' || view === 'sent' || view === 'starred' || view === 'spam' || view === 'trash'
    ? view
    : null
}

export function userLabelView(labelId: string): UserLabelView {
  return `label:${encodeURIComponent(labelId)}`
}

export function userLabelId(view: MailView): string | null {
  if (!view.startsWith('label:')) return null
  try {
    return decodeURIComponent(view.slice('label:'.length)) || null
  } catch {
    return null
  }
}

export function cachedThreadView(view: MailView): CachedThreadView | null {
  return labelMailboxView(view) ?? (userLabelId(view) ? (view as UserLabelView) : null)
}

/** Display names for every view the list/reading shell can host. */
export const VIEW_TITLES: Record<MailboxView | 'outbox', string> = {
  inbox: 'Inbox',
  allMail: 'All Mail',
  sent: 'Sent',
  drafts: 'Drafts',
  starred: 'Starred',
  snoozed: 'Snoozed',
  spam: 'Spam',
  trash: 'Trash',
  outbox: 'Outbox'
}

export interface DisplayThread {
  id: string
  from: string
  subject: string
  snippet: string
  at: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
  snoozed: boolean
  returned: boolean
  followUpReturned: boolean
  hasDraft: boolean
  dueAt?: number
  dueLabel?: string
  followUpDueLabel?: string
  followUpAwaiting?: 'snooze' | 'origin' | null
  labelIds: string[]
  lastMsgAt: number
}

export interface DisplayMessage {
  id: string
  pending: boolean
  /** Rendered as a compact trashed-message marker until revealed (SPEC F3). */
  trashed: boolean
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
    snoozed: row.snoozed,
    returned: row.returned,
    followUpReturned: row.followUpReturned === true,
    hasDraft: row.hasDraft,
    labelIds: row.labelIds,
    lastMsgAt: row.lastMsgAt
  }
}

export function displaySnoozedThread(row: SnoozedThreadRow): DisplayThread {
  // The snooze chip shows the snooze deadline; a follow-up's deadline renders
  // as its own chip, with why it has not fired yet when applicable (F9).
  const snoozeDue = row.snoozeDueAt ?? (row.snoozed ? row.dueAt : undefined)
  return {
    ...displayThread(row),
    ...(snoozeDue != null ? { dueAt: snoozeDue, dueLabel: formatSnoozeDate(snoozeDue) } : {}),
    ...(row.followUpDueAt != null
      ? {
          followUpDueLabel: formatSnoozeDate(row.followUpDueAt),
          followUpAwaiting: row.followUpAwaiting ?? null
        }
      : {})
  }
}

const EMPTY_DISPLAY_THREADS: DisplayThread[] = []
const displayThreadsCache = new WeakMap<readonly ThreadRow[], DisplayThread[]>()
const displaySnoozedThreadsCache = new WeakMap<readonly SnoozedThreadRow[], DisplayThread[]>()

/**
 * Row-array display mapping, cached by source identity. The refresh layer
 * already reuses an unchanged rows array (mailDataEquality), so a view switch
 * back to cached rows must not re-run Intl date formatting across 10,000 rows —
 * that alone would spend F3's 50 ms switch budget several times over.
 */
export function displayThreads(rows: readonly ThreadRow[]): DisplayThread[] {
  if (rows.length === 0) return EMPTY_DISPLAY_THREADS
  const cached = displayThreadsCache.get(rows)
  if (cached) return cached
  const mapped = rows.map(displayThread)
  displayThreadsCache.set(rows, mapped)
  return mapped
}

export function displaySnoozedThreads(rows: readonly SnoozedThreadRow[]): DisplayThread[] {
  if (rows.length === 0) return EMPTY_DISPLAY_THREADS
  const cached = displaySnoozedThreadsCache.get(rows)
  if (cached) return cached
  const mapped = rows.map(displaySnoozedThread)
  displaySnoozedThreadsCache.set(rows, mapped)
  return mapped
}

export function displayConversation(conversation: Conversation): DisplayConversation {
  return {
    threadId: conversation.threadId,
    subject: conversation.subject,
    bodyHydrationFailed: false,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      pending: message.pending === true,
      trashed: message.trashed === true,
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
