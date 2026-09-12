import { useState } from 'react'
import type { SearchCoverage } from '../../../shared/searchQuery'
import { Kbd } from './Kbd'

interface SearchHeaderProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  pending: boolean
  onQuery: (query: string) => void
  onClear: () => void
  onFocusQuery: () => void
  onSubmit: () => void
}

export function SearchHeader({
  inputRef,
  query,
  pending,
  onQuery,
  onClear,
  onFocusQuery,
  onSubmit
}: SearchHeaderProps): React.JSX.Element {
  const [queryFocused, setQueryFocused] = useState(false)

  return (
    <div
      data-testid="mail-view-header"
      className="flex min-h-[76px] flex-none items-center gap-3 border-b border-edge/50"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 flex-none fill-none stroke-ink-faint">
        <circle cx="10.5" cy="10.5" r="6.5" strokeWidth="1.8" />
        <path d="m15.5 15.5 4 4" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        data-testid="search-input"
        type="search"
        value={query}
        placeholder="Search mail"
        aria-label="Search mail"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => {
          setQueryFocused(true)
          onFocusQuery()
        }}
        onBlur={() => setQueryFocused(false)}
        onChange={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClear()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
        }}
        className="app-no-drag min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
      />
      {pending && (
        <span data-testid="search-pending" role="status" className="text-xs text-ink-faint">
          Searching…
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[10px] text-ink-dim">
        <Kbd>{queryFocused ? 'Enter' : 'Esc'}</Kbd>
        {queryFocused ? 'Search' : 'Edit'}
      </span>
      <span className="flex items-center gap-1.5 text-[10px] text-ink-dim">
        <Kbd>{queryFocused ? 'Esc' : 'Enter'}</Kbd>
        {queryFocused ? 'Close' : 'Open'}
      </span>
    </div>
  )
}

/**
 * What this search did not look at. `partial` leads because it is the one gap
 * caused by the query rather than by sync still running: the search filled its
 * recency window, so older matches were never considered.
 */
export function searchCoverageText(coverage: SearchCoverage, partial = false): string {
  const gaps: string[] = []
  if (partial) gaps.push('Showing the newest matches only — narrow the search to reach older mail')
  if (coverage.headersCapped) gaps.push('Older headers are outside the local sync limit')
  else if (!coverage.headersComplete) gaps.push('Older headers are still syncing')
  if (!coverage.indexComplete) gaps.push('The local index is still filling')
  // Not a count: older mail is header-only by design, so a running fraction that
  // never reaches its denominator told the reader less than the rule does.
  if (coverage.bodiesOnDemand) gaps.push('Older mail is searched by sender and subject until you open it')
  if (!coverage.attachmentFlagsComplete) gaps.push('Attachment coverage is still filling')
  return gaps.length > 0 ? gaps.join(' · ') : 'Local search coverage is complete'
}
