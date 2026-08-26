import type { ServerSearchPhase } from '../hooks/useServerSearch'

interface ServerSearchRowProps {
  phase: ServerSearchPhase
  resultCount: number
  message: string | null
  quotaWaitMs: number
  online: boolean
  onSearch: () => void
  onReconnect: () => void
  onFocusQuery: () => void
}

export function ServerSearchRow({
  phase,
  resultCount,
  message,
  quotaWaitMs,
  online,
  onSearch,
  onReconnect,
  onFocusQuery
}: ServerSearchRowProps): React.JSX.Element {
  const offline = !online
  const waiting = phase === 'waiting'
  const complete = phase === 'complete'
  const authRequired = phase === 'auth-required'
  const action = authRequired ? onReconnect : onSearch
  const enabled = authRequired || (!offline && !waiting && !complete)
  const label = authRequired
    ? 'Reconnect Google to search Gmail'
    : offline
      ? 'Search all of Gmail when you are back online'
      : waiting
        ? 'Waiting for Gmail…'
        : complete
          ? resultCount > 0
            ? `${resultCount} more ${resultCount === 1 ? 'conversation' : 'conversations'} from Gmail`
            : 'No more matches in Gmail'
          : phase === 'offline'
            ? 'Gmail was unreachable. Try again'
            : phase === 'error'
              ? 'Try searching all of Gmail again'
              : 'Search all of Gmail'
  const detail =
    complete && quotaWaitMs >= 1_000
      ? `Quota wait ${Math.round(quotaWaitMs / 1_000)}s`
      : phase === 'offline' || phase === 'error'
        ? message
        : null

  return (
    <button
      type="button"
      data-testid="search-all-gmail"
      data-search-state={offline ? 'offline' : phase}
      disabled={!enabled}
      onClick={action}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' && event.key !== 'Backspace' && event.key !== '/') return
        event.preventDefault()
        onFocusQuery()
      }}
      onMouseDown={(event) => event.preventDefault()}
      className="flex h-9 flex-none items-center border-t border-edge px-7 text-left text-xs text-ink-faint enabled:cursor-pointer enabled:hover:bg-active enabled:hover:text-ink disabled:cursor-default"
    >
      <span>{label}</span>
      {detail && <span className="ml-auto pl-4 text-[11px]">{detail}</span>}
    </button>
  )
}
