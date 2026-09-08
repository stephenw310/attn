import { useEffect, useMemo, useState } from 'react'
import type { SplitSummary } from '../../../shared/splits'
import { INBOX_ZERO_CLOCK_INTERVAL_MS } from '../tuning'
import { Seal } from './Hand'

const AFFIRMATIONS = ['All clear.', 'You are caught up.', 'Done for now.'] as const

export function inboxZeroRotation(date: Date): number {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  return day % AFFIRMATIONS.length
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
      className="relative min-h-0 flex-1 overflow-hidden outline-none"
      aria-label="Inbox zero"
    >
      <div className="relative flex h-full items-center justify-center p-8 text-center">
        <section data-testid="inbox-zero-message" className="w-full max-w-lg">
          <p className="app-small-caps text-[15px] tracking-[0.09em] text-accent">Inbox zero</p>
          <time
            className="font-serif app-figures mt-1 block text-[74px] leading-[82px] text-ink"
            dateTime={now.toISOString()}
          >
            {currentTime(now)}
          </time>
          <p className="font-letter mt-1 text-[20px] text-ink-dim italic">{AFFIRMATIONS[rotation]}</p>
          <div className="mt-7 flex justify-center">
            <Seal letter="a" />
          </div>

          {remaining.length > 0 ? (
            <div className="mt-9">
              <p className="app-small-caps text-[14px] text-accent">Letters elsewhere</p>
              <div data-testid="inbox-zero-remaining" className="mx-auto mt-4 flex max-w-sm flex-col">
                {remaining.map((split) => (
                  <button
                    key={split.id}
                    type="button"
                    data-testid="inbox-zero-split"
                    data-split-id={split.id}
                    onClick={() => onSelectSplit(split.id)}
                    className="flex cursor-pointer items-baseline justify-between gap-4 border-t border-edge py-2 text-[16px] text-ink-dim first:border-t-0 hover:text-ink"
                  >
                    <span>{split.name}</span>
                    <span className="app-figures text-[14.5px] text-ink-faint">
                      {`${split.total.toLocaleString()} waiting`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p
              data-testid="inbox-zero-all-clear"
              className="font-letter mt-8 text-[15px] text-ink-faint italic"
            >
              Every split is clear.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
