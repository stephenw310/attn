import {
  normalizeMailboxName,
  type ParsedSearchQuery,
  type SearchTextTerm,
  searchesDrafts
} from '../../shared/searchQuery'

export interface GmailSearchQuery {
  q: string
  includeSpamTrash: boolean
}

export interface GmailSearchQueryOptions {
  resolveLabelName?: (value: string) => string
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function searchValue(term: SearchTextTerm): string {
  return term.quoted || /[\s:"{}()[\]\\]/.test(term.value) ? quoted(term.value) : term.value
}

function locationQuery(value: string, resolveLabelName: (value: string) => string): string {
  const mailbox = normalizeMailboxName(value)
  if (mailbox === 'all' || mailbox === 'allmail') {
    return 'in:anywhere -in:spam -in:trash'
  }
  if (mailbox === 'draft' || mailbox === 'drafts') return 'in:drafts'
  if (mailbox === 'inbox' || mailbox === 'sent' || mailbox === 'spam' || mailbox === 'trash') {
    return `in:${mailbox}`
  }
  if (mailbox === 'starred') return 'is:starred'
  return `label:${quoted(resolveLabelName(value))}`
}

/**
 * Translate Attn's parsed query into Gmail's q= syntax. Snooze is local state
 * with no server equivalent, so `searchAllGmail` answers those queries from the
 * store and never reaches this translation.
 *
 * A term's field name is forwarded as Gmail spells it, which is not always what
 * the local index means by it: `to:` here matches Gmail's To header, while the
 * local FTS index folds to/cc/bcc/reply-to into one `recipients` column
 * (`sync/fts.ts`). Local and server results for one `to:` query legitimately
 * differ, and neither side is wrong.
 */
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
      const mailbox = normalizeMailboxName(filter.value)
      includeSpamTrash ||= mailbox === 'spam' || mailbox === 'trash'
      parts.push(locationQuery(filter.value, resolveLabelName))
    } else if (filter.kind === 'before' || filter.kind === 'after') {
      parts.push(`${filter.kind}:${filter.value.replaceAll('-', '/')}`)
    } else {
      parts.push(`${filter.kind}:${filter.value}`)
    }
  }
  if (!searchesDrafts(parsed)) parts.push('-in:drafts')
  return { q: parts.join(' '), includeSpamTrash }
}
