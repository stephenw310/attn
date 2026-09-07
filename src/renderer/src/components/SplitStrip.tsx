import { useEffect, useMemo, useRef, useState } from 'react'
import type { SplitSummary } from '../../../shared/splits'
import { TornRule } from './Hand'
import { Kbd } from './Kbd'

interface SplitStripProps {
  splits: readonly SplitSummary[]
  activeSplitId: string | null
  onSelect: (id: string) => void
  onManage: () => void
  onOpenSearch: () => void
}

/**
 * The strip under the view title. Inbox splits sit at its left when the
 * account has any; the way into search always sits at its right, so it keeps
 * one place on the page whatever mailbox is open.
 */
export function SplitStrip({
  splits,
  activeSplitId,
  onSelect,
  onManage,
  onOpenSearch
}: SplitStripProps): React.JSX.Element {
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

  const tabbed = splits.length > 1
  return (
    <div data-testid="split-strip" className="flex h-11 flex-none items-stretch pr-7 pl-[60px]">
      <div
        role="tablist"
        aria-label="Inbox splits"
        className={`flex min-w-0 overflow-x-auto ${tabbed ? '' : 'hidden'}`}
      >
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
              className={`app-no-drag relative flex flex-none cursor-pointer items-baseline gap-2 px-3 pt-2 pb-2.5 text-[16px] ${
                active ? 'text-ink' : 'text-ink-dim hover:text-ink'
              }`}
              onClick={(event) => {
                onSelect(split.id)
                event.currentTarget.blur()
              }}
            >
              {/* A bold copy underneath reserves the active width, so switching
                  splits cannot move the tabs beside it. */}
              <span className="grid">
                <span aria-hidden className="invisible col-start-1 row-start-1 font-bold">
                  {split.name}
                </span>
                <span className={`col-start-1 row-start-1 ${active ? 'font-bold' : ''}`}>{split.name}</span>
              </span>
              <span className="app-figures w-8 flex-none text-left text-[14px] text-ink-faint">
                {split.unread > 0 && (
                  <span data-testid="split-unread-count" data-count={split.unread}>
                    {split.unread > 999 ? '999+' : split.unread}
                  </span>
                )}
              </span>
              {active && (
                <span className="absolute right-2 bottom-0.5 left-2 block">
                  <TornRule />
                </span>
              )}
            </button>
          )
        })}
      </div>
      {tabbed && (
        <button
          type="button"
          data-testid="split-rules-settings"
          aria-label="Manage Inbox splits"
          title="Manage Inbox splits"
          onClick={onManage}
          className="app-no-drag mx-1 flex size-7 flex-none cursor-pointer items-center justify-center self-center text-ink-faint hover:text-ink"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-4 fill-none stroke-current"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Manage Inbox splits</title>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16M15 4v16" />
          </svg>
        </button>
      )}
      {overflowSplits.length > 0 && (
        <div ref={overflowRef} className="relative flex-none">
          <button
            type="button"
            data-testid="split-strip-overflow"
            aria-label="More inbox splits"
            aria-expanded={overflowOpen}
            title="More inbox splits"
            onClick={() => setOverflowOpen((open) => !open)}
            className="app-no-drag flex h-full w-11 cursor-pointer items-center justify-center text-base tracking-widest text-ink-faint hover:text-ink"
          >
            ···
          </button>
          {overflowOpen && (
            <div
              data-testid="split-overflow-menu"
              className="absolute top-full right-1 z-50 mt-1 min-w-48 border border-edge bg-raised p-1.5 shadow-menu"
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
                  className="flex w-full cursor-pointer items-center justify-between gap-4 px-2.5 py-1.5 text-left text-[15px] text-ink-dim hover:text-ink"
                >
                  <span>{split.name}</span>
                  {split.unread > 0 && <span className="app-figures text-accent">{split.unread}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="search-open"
        aria-label="Search mail"
        title="Search mail (/)"
        onClick={onOpenSearch}
        className="app-no-drag relative ml-auto flex flex-none cursor-pointer items-baseline gap-4 self-center pb-2 text-[15px] text-ink-faint hover:text-ink"
      >
        <span>Search the archive</span>
        <Kbd>/</Kbd>
        <span className="absolute right-0 bottom-0 left-0 block">
          <TornRule />
        </span>
      </button>
    </div>
  )
}
