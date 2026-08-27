import type { ParsedSearchQuery, SearchTextTerm } from '../../shared/searchQuery'

export interface GmailSearchQuery {
  q: string
  includeSpamTrash: boolean
}

export interface GmailSearchQueryOptions {
  resolveLabelName?: (value: string) => string
}

function normalizedMailbox(value: string): string {
  return value.toLowerCase().replaceAll(/[\s_-]/g, '')
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function searchValue(term: SearchTextTerm): string {
  return term.quoted || /[\s:"{}()[\]\\]/.test(term.value) ? quoted(term.value) : term.value
}

function locationQuery(value: string, resolveLabelName: (value: string) => string): string {
  const mailbox = normalizedMailbox(value)
  if (mailbox === 'all' || mailbox === 'allmail') {
    return 'in:anywhere -in:spam -in:trash'
  }
  if (mailbox === 'draft' || mailbox === 'drafts') return 'in:drafts'
  if (mailbox === 'inbox' || mailbox === 'sent' || mailbox === 'spam' || mailbox === 'trash') {
    return `in:${mailbox}`
  }
  if (mailbox === 'starred') return 'is:starred'
  if (mailbox === 'snoozed') return 'in:snoozed'
  return `label:${quoted(resolveLabelName(value))}`
}

/** Translate Attn's parsed query into Gmail's q= syntax. */
export function toGmailSearchQuery(
  parsed: ParsedSearchQuery,
  options: GmailSearchQueryOptions = {}
): GmailSearchQuery {
  const resolveLabelName = options.resolveLabelName ?? ((value: string) => value)
  const parts = parsed.terms.map((term) => {
    const value = searchValue(term)
    return term.field === 'any' ? value : `${term.field}:${value}`
  })
  let includeSpamTrash = false
  for (const filter of parsed.filters) {
    if (filter.kind === 'in') {
      const mailbox = normalizedMailbox(filter.value)
      includeSpamTrash ||= mailbox === 'spam' || mailbox === 'trash'
      parts.push(locationQuery(filter.value, resolveLabelName))
    } else if (filter.kind === 'before' || filter.kind === 'after') {
      parts.push(`${filter.kind}:${filter.value.replaceAll('-', '/')}`)
    } else if (filter.kind === 'is' && filter.value === 'snoozed') {
      parts.push('in:snoozed')
    } else {
      parts.push(`${filter.kind}:${filter.value}`)
    }
  }
  const searchesDrafts = parsed.filters.some(
    (filter) => filter.kind === 'in' && ['draft', 'drafts'].includes(normalizedMailbox(filter.value))
  )
  if (!searchesDrafts) parts.push('-in:drafts')
  return { q: parts.join(' '), includeSpamTrash }
}
