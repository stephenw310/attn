import type { ConversationMailbox, MailLabel } from '../../shared/mail'
import { parseSearchQuery } from '../../shared/searchQuery'
import type { MailView } from './mailDisplay'

function searchMailboxes(query: string): string[] {
  return parseSearchQuery(query)
    .filters.filter((filter) => filter.kind === 'in')
    .map((filter) => filter.value.toLowerCase().replaceAll(/[\s_-]/g, ''))
}

export function retainedSearchQuery(query: string, completedQuery: string | null): string {
  return completedQuery ?? query
}

export function conversationMailboxForSearch(query: string): ConversationMailbox {
  const mailboxes = searchMailboxes(query)
  if (mailboxes.includes('spam')) return 'spam'
  if (mailboxes.includes('trash')) return 'trash'
  return 'normal'
}

export function searchesDrafts(query: string): boolean {
  const mailboxes = searchMailboxes(query)
  return mailboxes.includes('draft') || mailboxes.includes('drafts')
}

/** Attn snoozes are local reminders, not Gmail's native snooze state. */
export function searchesLocalSnoozes(query: string): boolean {
  const parsed = parseSearchQuery(query)
  return parsed.filters.some(
    (filter) =>
      (filter.kind === 'is' && filter.value === 'snoozed') ||
      (filter.kind === 'in' && filter.value.toLowerCase().replaceAll(/[\s_-]/g, '') === 'snoozed')
  )
}

export function searchAllowsMove(query: string): boolean {
  const parsed = parseSearchQuery(query)
  if (parsed.filters.some((filter) => filter.kind === 'is' && filter.value === 'snoozed')) return false
  const blocked = new Set(['draft', 'drafts', 'snoozed', 'outbox'])
  return !searchMailboxes(query).some((mailbox) => blocked.has(mailbox))
}

function normalizedMailbox(value: string): string {
  return value.toLowerCase().replaceAll(/[\s_-]/g, '')
}

/** Re-evaluate only the row fields Move can change; the completed search already proved every other term. */
export function searchRetainsMovedThread(
  query: string,
  row: {
    hasAttachment: boolean
    labelIds: readonly string[]
    snoozed: boolean
    starred: boolean
    unread: boolean
  },
  labels: readonly MailLabel[]
): boolean {
  const parsed = parseSearchQuery(query)
  const normal = !row.labelIds.includes('SPAM') && !row.labelIds.includes('TRASH')
  const hasLocationFilter = parsed.filters.some((filter) => filter.kind === 'in')
  if (!hasLocationFilter && !normal) return false
  for (const filter of parsed.filters) {
    if (filter.kind === 'is') {
      if (filter.value === 'snoozed' && !row.snoozed) return false
      if (filter.value === 'starred' && !row.starred) return false
      if (filter.value === 'unread' && !row.unread) return false
      continue
    }
    if (filter.kind === 'has') {
      if (!row.hasAttachment) return false
      continue
    }
    if (filter.kind !== 'in') continue
    const mailbox = normalizedMailbox(filter.value)
    if (mailbox === 'inbox' && (!row.labelIds.includes('INBOX') || row.snoozed)) return false
    if (mailbox === 'snoozed' && !row.snoozed) return false
    if (mailbox === 'sent' && (!normal || !row.labelIds.includes('SENT'))) return false
    if (mailbox === 'starred' && (!normal || !row.labelIds.includes('STARRED'))) return false
    if (mailbox === 'spam' && !row.labelIds.includes('SPAM')) return false
    if (mailbox === 'trash' && !row.labelIds.includes('TRASH')) return false
    if ((mailbox === 'all' || mailbox === 'allmail') && !normal) return false
    if (
      ['inbox', 'snoozed', 'sent', 'starred', 'spam', 'trash', 'all', 'allmail', 'draft', 'drafts'].includes(
        mailbox
      )
    ) {
      continue
    }
    const userLabel = labels.find(
      (label) =>
        label.type.toLowerCase() === 'user' &&
        (label.id.toLowerCase() === filter.value.toLowerCase() ||
          label.name.toLowerCase() === filter.value.toLowerCase())
    )
    if (userLabel && (!normal || !row.labelIds.includes(userLabel.id))) return false
  }
  return true
}

export function triageViewForSearch(query: string): MailView {
  return searchMailboxes(query).includes('inbox') ? 'inbox' : 'allMail'
}
