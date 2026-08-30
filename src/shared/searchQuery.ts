import type { Draft } from './drafts'
import type { ThreadRow } from './mail'

export type SearchTextField = 'any' | 'from' | 'to' | 'subject'

export interface SearchTextTerm {
  field: SearchTextField
  value: string
  /** Quoted input is an exact phrase. Unquoted input receives prefix matching. */
  quoted: boolean
}

export type SearchFilter =
  | { kind: 'in'; value: string }
  | { kind: 'is'; value: 'unread' | 'starred' | 'snoozed' }
  | { kind: 'has'; value: 'attachment' }
  | { kind: 'before' | 'after'; value: string }

export interface ParsedSearchQuery {
  terms: SearchTextTerm[]
  filters: SearchFilter[]
}

export interface SearchCoverage {
  headersComplete: boolean
  indexComplete: boolean
  attachmentFlagsComplete: boolean
  /**
   * Stored mail beyond the eager-bodies window is header-only until opened, so
   * a body-text term can miss it. This is a flag rather than a count because
   * counting bodies meant reading every stored message on every search: 414 ms
   * at a million messages, and it never reaches "complete" anyway, since
   * on-demand bodies are the design rather than a sync stage that finishes.
   */
  bodiesOnDemand: boolean
}

export interface SearchResponse {
  rows: ThreadRow[]
  drafts: Draft[]
  coverage: SearchCoverage
  /**
   * The search filled its recency window, so matches older than the newest few
   * thousand — or ones only a filter would have selected — were not considered.
   */
  partial: boolean
}

export type ServerSearchResponse =
  | { status: 'ok'; rows: ThreadRow[]; quotaWaitMs: number }
  | { status: 'offline' | 'auth-required' | 'error'; message: string }

interface QueryToken {
  value: string
  quoted: boolean
}

function queryTokens(query: string): QueryToken[] {
  const tokens: QueryToken[] = []
  let index = 0
  while (index < query.length) {
    while (/\s/.test(query[index] ?? '')) index++
    if (index >= query.length) break
    let value = ''
    let inQuote = false
    let quoted = false
    while (index < query.length) {
      const character = query[index]
      if (character === '"') {
        inQuote = !inQuote
        quoted = true
        index++
        continue
      }
      if (!inQuote && /\s/.test(character)) break
      value += character
      index++
    }
    if (value) tokens.push({ value, quoted })
  }
  return tokens
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Parse user search syntax without throwing. Unsupported forms stay literal text. */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const terms: SearchTextTerm[] = []
  const filters: SearchFilter[] = []
  for (const token of queryTokens(query.trim())) {
    const separator = token.value.indexOf(':')
    const name = separator > 0 ? token.value.slice(0, separator).toLowerCase() : ''
    const value = separator > 0 ? token.value.slice(separator + 1) : ''
    if (value) {
      if (name === 'from' || name === 'to' || name === 'subject') {
        terms.push({ field: name, value, quoted: token.quoted })
        continue
      }
      if (name === 'in') {
        filters.push({ kind: 'in', value })
        continue
      }
      if (name === 'is' && (value === 'unread' || value === 'starred' || value === 'snoozed')) {
        filters.push({ kind: 'is', value })
        continue
      }
      if (name === 'has' && value === 'attachment') {
        filters.push({ kind: 'has', value })
        continue
      }
      if ((name === 'before' || name === 'after') && validDate(value)) {
        filters.push({ kind: name, value })
        continue
      }
    }
    terms.push({ field: 'any', value: token.value, quoted: token.quoted })
  }
  return { terms, filters }
}

const FTS_COLUMNS: Record<Exclude<SearchTextField, 'any'>, string> = {
  from: 'sender',
  to: 'recipients',
  subject: 'subject'
}

function quotedFtsValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** Compile parsed text terms into parameter-safe FTS5 MATCH syntax. */
export function searchMatchExpression(parsed: ParsedSearchQuery): string | null {
  if (parsed.terms.length === 0) return null
  return parsed.terms
    .map((term) => {
      const value = `${quotedFtsValue(term.value)}${term.quoted ? '' : '*'}`
      return term.field === 'any' ? value : `${FTS_COLUMNS[term.field]} : ${value}`
    })
    .join(' AND ')
}

export function searchDateMilliseconds(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}
