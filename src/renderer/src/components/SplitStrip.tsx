import { useEffect, useMemo, useRef, useState } from 'react'
import type { SplitSummary } from '../../../shared/splits'

interface SplitStripProps {
  splits: readonly SplitSummary[]
  activeSplitId: string | null
  onSelect: (id: string) => void
  onManage: () => void
}

export function SplitStrip({
  splits,
  activeSplitId,
  onSelect,
  onManage
}: SplitStripProps): React.JSX.Element | null {
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  const { visibleSplits, overflowSplits } = useMemo(() => {
    const limit = 8
    if (splits.length <= limit) return { visibleSplits: splits, overflowSplits: [] }
    const activeIndex = splits.findIndex((split) => split.id === activeSplitId)
    const visible =
      activeIndex >= limit ? [...splits.slice(0, limit - 1), splits[activeIndex]] : splits.slice(0, limit)
    const visibleIds = new Set(visible.map((split) => split.id))
    return {
      visibleSplits: visible,
      overflowSplits: splits.filter((split) => !visibleIds.has(split.id))
    }
  }, [activeSplitId, splits])

  useEffect(() => {
    if (!overflowOpen) return
    const close = (event: MouseEvent): void => {
      if (!overflowRef.current?.contains(event.target as Node)) setOverflowOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOverflowOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [overflowOpen])

  if (splits.length <= 1) return null
  return (
    <div
      data-testid="split-strip"
      className="flex h-10 flex-none items-stretch border-b border-edge bg-raised/25 pl-[45px]"
    >
      <div role="tablist" aria-label="Inbox splits" className="flex min-w-0 flex-1 overflow-x-auto">
        {visibleSplits.map((split) => {
          const active = split.id === activeSplitId
          return (
            <button
              key={split.id}
              type="button"
              role="tab"
              data-testid="split-tab"
              data-split-id={split.id}
              data-active={active || undefined}
              aria-selected={active}
              title={`${split.total.toLocaleString()} conversations`}
              className={`app-no-drag flex flex-none cursor-pointer items-center gap-1.5 border-b-2 px-3 text-xs transition-colors ${
                active
                  ? 'border-accent font-semibold text-ink'
                  : 'border-transparent font-medium text-ink-dim hover:bg-active/60 hover:text-ink'
              }`}
              onClick={(event) => {
                onSelect(split.id)
                event.currentTarget.blur()
              }}
            >
              <span>{split.name}</span>
              {split.unread > 0 && (
                <span
                  data-testid="split-unread-count"
                  data-count={split.unread}
                  className="rounded-full bg-active px-1.5 py-0.5 text-[10px] leading-none font-semibold tabular-nums text-accent"
                >
                  {split.unread > 999 ? '999+' : split.unread}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {overflowSplits.length > 0 && (
        <div ref={overflowRef} className="relative flex-none">
          <button
            type="button"
            data-testid="split-strip-overflow"
            aria-label="More inbox splits"
            aria-expanded={overflowOpen}
            title="More inbox splits"
            onClick={() => setOverflowOpen((open) => !open)}
            className="app-no-drag flex h-full w-11 cursor-pointer items-center justify-center border-l border-edge text-base tracking-widest text-ink-faint hover:bg-active hover:text-ink"
          >
            ···
          </button>
          {overflowOpen && (
            <div
              data-testid="split-overflow-menu"
              className="absolute top-full right-1 z-50 mt-1 min-w-48 rounded-lg border border-edge bg-raised p-1.5 shadow-menu"
            >
              {overflowSplits.map((split) => (
                <button
                  key={split.id}
                  type="button"
                  role="tab"
                  data-testid="split-overflow-tab"
                  data-split-id={split.id}
                  aria-selected={split.id === activeSplitId}
                  onClick={() => {
                    setOverflowOpen(false)
                    onSelect(split.id)
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-xs text-ink-dim hover:bg-active hover:text-ink"
                >
                  <span>{split.name}</span>
                  {split.unread > 0 && <span className="tabular-nums text-accent">{split.unread}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="split-rules-settings"
        aria-label="Split Inbox settings"
        title="Split Inbox settings"
        onClick={onManage}
        className="app-no-drag flex h-full w-11 flex-none cursor-pointer items-center justify-center border-l border-edge text-ink-faint hover:bg-active hover:text-ink"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="size-4 fill-none stroke-current"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>Split Inbox settings</title>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.09A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4.05v.09A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.09v4.05h-.09A1.7 1.7 0 0 0 19.4 15Z" />
        </svg>
      </button>
    </div>
  )
}
