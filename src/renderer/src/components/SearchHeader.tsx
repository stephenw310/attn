import { useState } from 'react'
import type { SearchCoverage } from '../../../shared/searchQuery'

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
      className="flex h-[44px] flex-none items-center gap-3 border-b border-edge pr-7 pl-[53px]"
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
        className="app-no-drag min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      {pending && (
        <span data-testid="search-pending" role="status" className="text-xs text-ink-faint">
          Searching…
        </span>
      )}
      <span className="rounded border border-edge px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
        {queryFocused ? 'Enter Search' : 'Esc Edit'}
      </span>
      <span className="rounded border border-edge px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
        {queryFocused ? 'Esc Close' : 'Enter Open'}
      </span>
    </div>
  )
}

export function searchCoverageText(coverage: SearchCoverage): string {
  const gaps: string[] = []
  if (!coverage.headersComplete) gaps.push('Older headers are still syncing')
  if (!coverage.indexComplete) gaps.push('The local index is still filling')
  if (coverage.messagesWithBody < coverage.messagesTotal) {
    const number = new Intl.NumberFormat()
    gaps.push(
      `Body text and filenames cover ${number.format(coverage.messagesWithBody)} of ${number.format(
        coverage.messagesTotal
      )} messages`
    )
  }
  if (!coverage.attachmentFlagsComplete) gaps.push('Attachment coverage is still filling')
  return gaps.length > 0 ? gaps.join(' · ') : 'Local search coverage is complete'
}
