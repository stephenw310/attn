/**
 * What the app is carrying for you right now, written beside the view title:
 * changes waiting to reach Gmail, mail waiting to go out, and work held
 * because Google needs the user again.
 */
export function MailActivity({
  pendingActions,
  pausedActions,
  outbox,
  onReconnect,
  onOpenOutbox
}: {
  pendingActions: number
  pausedActions: number
  outbox: number
  onReconnect: () => void
  onOpenOutbox?: () => void
}): React.JSX.Element | null {
  if (pendingActions === 0 && pausedActions === 0 && outbox === 0) return null
  return (
    <div data-testid="mail-activity" className="flex items-baseline gap-5 text-[15px] text-ink-faint">
      {pendingActions > 0 && (
        <span
          data-testid="pending-count"
          title="Changes waiting to reach Gmail"
          className="app-figures whitespace-nowrap"
        >
          {pendingActions === 1 ? '1 letter waiting' : `${pendingActions} letters waiting`}
        </span>
      )}
      {outbox > 0 && (
        <button
          type="button"
          data-testid="outbox-count"
          disabled={!onOpenOutbox}
          className="app-figures cursor-pointer whitespace-nowrap hover:text-ink disabled:cursor-default disabled:hover:text-inherit"
          onClick={onOpenOutbox}
        >
          {outbox} in Outbox
        </button>
      )}
      {/* Paused rows are a subset of `pendingActions` — the rest of the queue is
          still draining — and outbox sends can never be auth-paused at all, so
          the reconnect control is its own readout rather than a relabeled count. */}
      {pausedActions > 0 && (
        <button
          type="button"
          data-testid="action-reconnect"
          onClick={onReconnect}
          title="Google authorization expired; reconnect to retry held changes"
          className="cursor-pointer whitespace-nowrap text-accent hover:underline"
        >
          <span data-testid="paused-count" className="app-figures">{`${pausedActions} held.`}</span> Reconnect
          Google
        </button>
      )}
    </div>
  )
}
