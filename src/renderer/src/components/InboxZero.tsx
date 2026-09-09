import { useEffect, useMemo, useState } from 'react'
import type { SplitSummary } from '../../../shared/splits'
import alpineDawn from '../assets/inbox-zero/alpine-dawn.jpg'
import coastalDusk from '../assets/inbox-zero/coastal-dusk.jpg'
import forestMorning from '../assets/inbox-zero/forest-morning.jpg'
import { INBOX_ZERO_CLOCK_INTERVAL_MS } from '../tuning'

const BACKGROUNDS = [alpineDawn, coastalDusk, forestMorning] as const
const AFFIRMATIONS = ['All clear.', 'You are caught up.', 'Done for now.'] as const

export function inboxZeroRotation(date: Date): number {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  return day % BACKGROUNDS.length
}

function currentTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

interface InboxZeroProps {
  activeSplitId: string
  splits: readonly SplitSummary[]
  listRef: React.RefObject<HTMLElement | null>
  onSelectSplit: (id: string) => void
}

export function InboxZero({
  activeSplitId,
  splits,
  listRef,
  onSelectSplit
}: InboxZeroProps): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  const rotation = inboxZeroRotation(now)
  const remaining = useMemo(
    () => splits.filter((split) => split.id !== activeSplitId && split.total > 0),
    [activeSplitId, splits]
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), INBOX_ZERO_CLOCK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <main
      ref={listRef}
      data-testid="inbox-zero"
      data-background-index={rotation}
      tabIndex={-1}
      className="relative my-4 min-h-0 flex-1 overflow-hidden rounded-lg outline-none"
      aria-label="Inbox zero"
    >
      <img
        src={BACKGROUNDS[rotation]}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 size-full object-cover"
      />
      <div className="app-inbox-zero-scrim absolute inset-0" aria-hidden="true" />
      <div className="app-inbox-zero-copy relative flex h-full items-center justify-center p-8 text-center">
        <section data-testid="inbox-zero-message" className="w-full max-w-xl px-8 py-9">
          <p className="text-xs font-medium">Inbox zero</p>
          <time
            className="mt-2 block text-5xl font-normal tracking-tight tabular-nums"
            dateTime={now.toISOString()}
          >
            {currentTime(now)}
          </time>
          <p className="app-inbox-zero-muted mt-3 text-base">{AFFIRMATIONS[rotation]}</p>

          {remaining.length > 0 ? (
            <div className="mt-8 border-t border-current/20 pt-5">
              <p className="app-inbox-zero-muted text-[11px] font-normal">Conversations elsewhere</p>
              <div data-testid="inbox-zero-remaining" className="mt-3 flex flex-wrap justify-center gap-2">
                {remaining.map((split) => (
                  <button
                    key={split.id}
                    type="button"
                    data-testid="inbox-zero-split"
                    data-split-id={split.id}
                    onClick={() => onSelectSplit(split.id)}
                    className="app-inbox-zero-chip cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium tabular-nums"
                  >
                    {split.name}: {split.total.toLocaleString()} total
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p data-testid="inbox-zero-all-clear" className="app-inbox-zero-muted mt-8 text-xs">
              Every split is clear.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
