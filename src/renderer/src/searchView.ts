import type { ConversationMailbox } from '../../shared/mail'
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

export function triageViewForSearch(query: string): MailView {
  return searchMailboxes(query).includes('inbox') ? 'inbox' : 'allMail'
}
