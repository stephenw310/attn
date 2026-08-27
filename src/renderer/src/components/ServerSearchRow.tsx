import type { ServerSearchPhase } from '../hooks/useServerSearch'

interface ServerSearchRowProps {
  phase: ServerSearchPhase
  resultCount: number
  message: string | null
  quotaWaitMs: number
  online: boolean
}

export function ServerSearchRow({
  phase,
  resultCount,
  message,
  quotaWaitMs,
  online
}: ServerSearchRowProps): React.JSX.Element {
  const offline = !online
  const waiting = phase === 'waiting'
  const complete = phase === 'complete'
  const authRequired = phase === 'auth-required'
  const label = offline
    ? 'Search all of Gmail when you are back online'
    : authRequired
      ? 'Press Enter to reconnect Google and search Gmail'
      : waiting
        ? 'Searching all of Gmail…'
        : complete
          ? resultCount > 0
            ? `${resultCount} more ${resultCount === 1 ? 'conversation' : 'conversations'} from Gmail`
            : 'No more matches in Gmail'
          : phase === 'offline'
            ? 'Gmail was unreachable. Press Enter to try again'
            : phase === 'error'
              ? 'Gmail search failed. Press Enter to try again'
              : 'Press Enter to search all of Gmail'
  const detail =
    complete && quotaWaitMs >= 1_000
      ? `Quota wait ${Math.round(quotaWaitMs / 1_000)}s`
      : phase === 'offline' || phase === 'error'
        ? message
        : null

  return (
    <div
      data-testid="search-all-gmail"
      data-search-state={offline ? 'offline' : phase}
      role="status"
      className="flex h-9 flex-none items-center border-t border-edge px-7 text-left text-xs text-ink-faint"
    >
      <span>{label}</span>
      {detail && <span className="ml-auto pl-4 text-[11px]">{detail}</span>}
    </div>
  )
}
