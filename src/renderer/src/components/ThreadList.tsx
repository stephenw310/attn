import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MailLabel, ThreadListView } from '../../../shared/mail'
import { dateGroup } from '../dateGroup'
import type { DisplayThread } from '../mailDisplay'

const LABEL_PALETTE = [
  {
    backgroundColor: 'var(--attn-label-1-bg)',
    borderColor: 'var(--attn-label-1-edge)',
    color: 'var(--attn-label-1-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-2-bg)',
    borderColor: 'var(--attn-label-2-edge)',
    color: 'var(--attn-label-2-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-3-bg)',
    borderColor: 'var(--attn-label-3-edge)',
    color: 'var(--attn-label-3-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-4-bg)',
    borderColor: 'var(--attn-label-4-edge)',
    color: 'var(--attn-label-4-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-5-bg)',
    borderColor: 'var(--attn-label-5-edge)',
    color: 'var(--attn-label-5-ink)'
  },
  {
    backgroundColor: 'var(--attn-label-6-bg)',
    borderColor: 'var(--attn-label-6-edge)',
    color: 'var(--attn-label-6-ink)'
  }
] as const

function labelColor(labelId: string): (typeof LABEL_PALETTE)[number] {
  let hash = 0
  for (const character of labelId) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length]
}

function ThreadLabels({
  labelIds,
  labelsById,
  onOpenLabel
}: {
  labelIds: readonly string[]
  labelsById: ReadonlyMap<string, MailLabel>
  onOpenLabel: (labelId: string) => void
}): React.JSX.Element {
  return (
    <>
      {labelIds.map((labelId) => {
        const label = labelsById.get(labelId)
        return label ? (
          <button
            type="button"
            key={labelId}
            data-testid="label-chip"
            title={label.name}
            className="max-w-24 flex-none cursor-pointer truncate rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={labelColor(labelId)}
            onClick={(event) => {
              event.stopPropagation()
              onOpenLabel(labelId)
            }}
          >
            {label.name}
          </button>
        ) : null
      })}
    </>
  )
}

function ThreadStatusChips({ thread }: { thread: DisplayThread }): React.JSX.Element {
  return (
    <>
      {thread.returned && (
        <span
          data-testid="chip-returned"
          className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-medium text-accent"
        >
          Returned
        </span>
      )}
      {thread.dueAt !== undefined && (
        <span
          data-testid="chip-snooze-due"
          title={thread.dueLabel}
          className="rounded-full border border-edge px-2 py-0.5 text-ink-dim"
        >
          {thread.dueLabel}
        </span>
      )}
    </>
  )
}

type ThreadListKind = ThreadListView | 'label' | 'search'

const EMPTY_TEXT: Record<ThreadListKind, string> = {
  inbox: 'Inbox empty',
  allMail: 'All Mail is empty',
  sent: 'Nothing sent yet',
  starred: 'Nothing starred',
  snoozed: 'Nothing snoozed',
  spam: 'Spam is empty',
  trash: 'Trash is empty',
  label: 'No conversations with this label',
  search: 'No matching conversations'
}

interface ThreadListProps {
  threads: DisplayThread[]
  view: ThreadListKind
  hasMore?: boolean
  loadingMore?: boolean
  loadingInitial?: boolean
  syncing: boolean
  readerOpen: boolean
  selectedIndex: number
  selectionVisible?: boolean
  selectedIds: ReadonlySet<string>
  exitingThreadIds: ReadonlySet<string>
  labelsById: ReadonlyMap<string, MailLabel>
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  /** The scroll element, owned by the parent so per-view scroll can be saved and restored. */
  listRef: React.RefObject<HTMLElement | null>
  onExtendSelection: (index: number) => void
  onLoadMore?: () => void
  onOpenLabel: (labelId: string) => void
  onOpen: (index: number) => void
  sectionDivider?: { beforeIndex: number; label: string }
}

const VIRTUAL_ROW_HEIGHT = 46
const VIRTUAL_GROUP_HEIGHT = 44
const VIRTUAL_SECTION_DIVIDER_HEIGHT = 34
const VIRTUAL_OVERSCAN_PX = VIRTUAL_ROW_HEIGHT * 12
const NOOP = (): void => {}

interface VirtualThreadEntry {
  index: number
  top: number
  height: number
  group: ReturnType<typeof dateGroup>
  groupKey: string
  showGroup: boolean
  dividerHeight: number
}

function virtualLayout(
  threads: readonly DisplayThread[],
  view: ThreadListKind,
  dividerBeforeIndex?: number
): VirtualThreadEntry[] {
  let top = 0
  let previousGroup: ReturnType<typeof dateGroup> | undefined
  let activeGroupKey = ''
  const groupOccurrences = new Map<ReturnType<typeof dateGroup>, number>()
  return threads.map((thread, index) => {
    const dividerHeight = index === dividerBeforeIndex ? VIRTUAL_SECTION_DIVIDER_HEIGHT : 0
    if (dividerHeight > 0) previousGroup = undefined
    const group = dateGroup(thread)
    // Snoozed sorts by due time, so relative-date groups would mislead there.
    const showGroup = view !== 'snoozed' && group !== previousGroup
    if (showGroup) {
      const occurrence = groupOccurrences.get(group) ?? 0
      activeGroupKey = `${group}\0${occurrence}`
      groupOccurrences.set(group, occurrence + 1)
    }
    const height = VIRTUAL_ROW_HEIGHT + (showGroup ? VIRTUAL_GROUP_HEIGHT : 0) + dividerHeight
    const entry = { index, top, height, group, groupKey: activeGroupKey, showGroup, dividerHeight }
    top += height
    previousGroup = group
    return entry
  })
}

function visibleEntries(
  layout: readonly VirtualThreadEntry[],
  scrollTop: number,
  viewportHeight: number
): VirtualThreadEntry[] {
  if (layout.length === 0) return []
  const lower = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX)
  const upper = scrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX
  let low = 0
  let high = layout.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const item = layout[middle]
    if (item.top + item.height < lower) low = middle + 1
    else high = middle
  }
  const visible: VirtualThreadEntry[] = []
  for (let index = low; index < layout.length; index++) {
    const item = layout[index]
    if (item.top > upper) break
    visible.push(item)
  }
  return visible
}

export const ThreadList = memo(function ThreadList(props: ThreadListProps): React.JSX.Element {
  const {
    threads,
    view,
    hasMore = false,
    loadingMore = false,
    loadingInitial = false,
    syncing,
    readerOpen,
    selectedIndex,
    selectionVisible = true,
    selectedIds,
    exitingThreadIds,
    labelsById,
    selectedRowRef,
    listRef,
    onExtendSelection,
    onLoadMore = NOOP,
    onOpenLabel,
    onOpen,
    sectionDivider
  } = props
  const virtualContentRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const followedSelectionRef = useRef<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(800)
  const dividerBeforeIndex =
    sectionDivider && sectionDivider.beforeIndex >= 0 && sectionDivider.beforeIndex < threads.length
      ? sectionDivider.beforeIndex
      : undefined
  const layout = useMemo(
    () => virtualLayout(threads, view, dividerBeforeIndex),
    [dividerBeforeIndex, threads, view]
  )
  const projected = useMemo(() => {
    if (exitingThreadIds.size === 0) return null
    const survivingThreads = threads.filter((thread) => !exitingThreadIds.has(thread.id))
    const projectedRowsBeforeDivider =
      dividerBeforeIndex === undefined
        ? undefined
        : threads.slice(0, dividerBeforeIndex).filter((thread) => !exitingThreadIds.has(thread.id)).length
    const projectedDividerBeforeIndex =
      projectedRowsBeforeDivider !== undefined && projectedRowsBeforeDivider < survivingThreads.length
        ? projectedRowsBeforeDivider
        : undefined
    const projectedLayout = virtualLayout(survivingThreads, view, projectedDividerBeforeIndex)
    const byThreadId = new Map<string, VirtualThreadEntry>()
    for (const entry of projectedLayout) byThreadId.set(survivingThreads[entry.index].id, entry)
    return {
      threads: survivingThreads,
      layout: projectedLayout,
      byThreadId,
      dividerBeforeIndex: projectedDividerBeforeIndex
    }
  }, [dividerBeforeIndex, exitingThreadIds, threads, view])
  const projectedGroupTops = useMemo(() => {
    const tops = new Map<string, number>()
    for (const entry of projected?.layout ?? []) {
      if (entry.showGroup) tops.set(entry.groupKey, entry.top + entry.dividerHeight)
    }
    return tops
  }, [projected])
  const layoutByThreadId = useMemo(() => {
    const byThreadId = new Map<string, VirtualThreadEntry>()
    for (const entry of layout) byThreadId.set(threads[entry.index].id, entry)
    return byThreadId
  }, [layout, threads])
  const virtualHeight =
    layout.length > 0 ? layout[layout.length - 1].top + layout[layout.length - 1].height : 0
  const projectedLastEntry = projected?.layout.at(-1)
  const projectedVirtualHeight = projected
    ? projectedLastEntry
      ? projectedLastEntry.top + projectedLastEntry.height
      : 0
    : virtualHeight
  const mountedEntries = useMemo(() => {
    const current = visibleEntries(layout, scrollTop, viewportHeight)
    if (!projected) return current
    const mountedByIndex = new Map(current.map((entry) => [entry.index, entry]))
    for (const entry of visibleEntries(projected.layout, scrollTop, viewportHeight)) {
      const thread = projected.threads[entry.index]
      const currentEntry = layoutByThreadId.get(thread.id)
      if (currentEntry) mountedByIndex.set(currentEntry.index, currentEntry)
    }
    return [...mountedByIndex.values()].sort((left, right) => left.index - right.index)
  }, [layout, layoutByThreadId, projected, scrollTop, viewportHeight])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => setViewportHeight(list.clientHeight || 800)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [listRef])

  useLayoutEffect(() => {
    if (readerOpen) {
      followedSelectionRef.current = null
      return
    }
    const list = listRef.current
    const selectedThread = threads[selectedIndex]
    const selected =
      (selectedThread ? projected?.byThreadId.get(selectedThread.id) : undefined) ?? layout[selectedIndex]
    if (!list || !selected) return
    const selectionKey = `${view}\u0000${selectedThread?.id ?? selectedIndex}`
    if (followedSelectionRef.current === selectionKey) return
    followedSelectionRef.current = selectionKey

    // The sizer starts inside the list's own padding box. `offsetTop` would
    // measure from the nearest positioned ancestor — <main> is static, so that
    // is <body>, which folds the whole header height into the scroll math.
    // Measure against the list itself so this stays a pure in-content offset.
    const content = virtualContentRef.current
    const contentTop = content
      ? content.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      : 0
    const visibleTop = Math.max(0, list.scrollTop - contentTop)
    const visibleBottom = visibleTop + viewportHeight
    let nextScrollTop = list.scrollTop
    if (selected.top < visibleTop) nextScrollTop = contentTop + selected.top
    else if (selected.top + selected.height > visibleBottom) {
      nextScrollTop = contentTop + selected.top + selected.height - viewportHeight
    }
    nextScrollTop = Math.max(0, nextScrollTop)
    if (nextScrollTop === list.scrollTop) return
    list.scrollTop = nextScrollTop
    pendingScrollTopRef.current = nextScrollTop
    setScrollTop(nextScrollTop)
  }, [layout, listRef, projected, readerOpen, selectedIndex, threads, view, viewportHeight])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  useEffect(() => {
    if (!hasMore || loadingMore || threads.length === 0) return
    if (selectedIndex >= threads.length - 20) onLoadMore()
  }, [hasMore, loadingMore, onLoadMore, selectedIndex, threads.length])

  const renderThread = (entry: VirtualThreadEntry): React.JSX.Element[] => {
    const { index, group, groupKey, showGroup } = entry
    const thread = threads[index]
    const selected = index === selectedIndex
    const selectionShown = selectionVisible && selected
    const checked = selectedIds.has(thread.id)
    const done = view === 'allMail' && !thread.labelIds.includes('INBOX')
    const exiting = exitingThreadIds.has(thread.id)
    const projectedEntry = projected?.byThreadId.get(thread.id)
    const currentRowTop = entry.top + entry.dividerHeight + (showGroup ? VIRTUAL_GROUP_HEIGHT : 0)
    const projectedRowTop = projectedEntry
      ? projectedEntry.top +
        projectedEntry.dividerHeight +
        (projectedEntry.showGroup ? VIRTUAL_GROUP_HEIGHT : 0)
      : undefined
    const row = (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global
      // biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is global
      <div
        key="row"
        ref={selected ? selectedRowRef : null}
        data-testid="thread-row"
        data-thread-index={index}
        data-thread-id={thread.id}
        data-last-msg-at={thread.lastMsgAt}
        data-selected={selectionShown || undefined}
        data-checked={checked || undefined}
        data-unread={thread.unread || undefined}
        data-starred={thread.starred || undefined}
        data-done={done || undefined}
        data-exiting={exiting || undefined}
        className={`flex h-[46px] cursor-default select-none items-center gap-3.5 border-l-[3px] pr-7 pl-5 ${
          selectionShown ? 'border-l-accent' : 'border-l-transparent'
        } ${checked ? 'bg-accent/[0.12]' : selectionShown ? 'bg-accent/[0.07]' : ''} ${
          exiting ? 'app-thread-exit' : ''
        }`}
        onClick={(event) => (event.shiftKey ? onExtendSelection(index) : onOpen(index))}
      >
        <span className="flex size-4 flex-none items-center justify-center self-center" aria-hidden>
          {checked ? (
            <span className="flex size-4 items-center justify-center rounded-[4px] bg-accent text-[11px] font-bold text-ground">
              ✓
            </span>
          ) : (
            <span className="app-thread-unread-dot size-1.5 rounded-full" />
          )}
        </span>
        <span
          data-testid="thread-sender"
          className="app-thread-sender w-52 flex-none overflow-hidden text-ellipsis whitespace-nowrap"
        >
          {thread.from}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-faint">
          {thread.hasDraft && (
            <span
              data-testid="chip-draft"
              className="flex-none rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent"
            >
              Draft
            </span>
          )}
          <ThreadLabels labelIds={thread.labelIds} labelsById={labelsById} onOpenLabel={onOpenLabel} />
          <span className="app-thread-star flex-none text-star" title="Starred">
            ★
          </span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            <span data-testid="thread-subject" className="app-thread-subject">
              {thread.subject}
            </span>
            <span data-testid="thread-snippet"> — {thread.snippet}</span>
          </span>
        </span>
        <span className="flex flex-none items-center gap-2.5 text-xs">
          <ThreadStatusChips thread={thread} />
          {thread.hasAttachment && <span title="Has attachment">📎</span>}
          <span data-testid="thread-time" className="app-thread-time min-w-[70px] text-right tabular-nums">
            {thread.at}
          </span>
          {view === 'allMail' && (
            <span className="flex size-4 flex-none items-center justify-center">
              {done && (
                <span
                  data-testid="thread-done-indicator"
                  role="img"
                  aria-label="Done, not in Inbox"
                  title="Done, not in Inbox"
                  className="text-[14px] font-bold text-status-live"
                >
                  ✓
                </span>
              )}
            </span>
          )}
        </span>
      </div>
    )
    const projectedGroupTop = projectedGroupTops.get(groupKey)
    const groupRemoved = projected !== null && projectedGroupTop === undefined
    const parts: React.JSX.Element[] = []
    if (showGroup) {
      parts.push(
        <div
          key={`group:${groupKey}`}
          data-testid="thread-date-group"
          className={`absolute right-0 left-0 h-[44px] px-8 pt-5 pb-2 text-xs font-semibold text-ink-faint ${
            projectedGroupTop !== undefined ? 'app-thread-position-shift' : ''
          } ${groupRemoved ? 'app-thread-exit' : ''}`}
          style={{ top: projectedGroupTop ?? entry.top + entry.dividerHeight }}
        >
          {group}
        </div>
      )
    }
    parts.push(
      <div
        key={`thread:${thread.id}`}
        className={`absolute right-0 left-0 overflow-x-clip ${
          projectedEntry ? 'app-thread-position-shift' : ''
        } ${exiting ? 'z-10' : ''}`}
        style={{
          top: exiting ? currentRowTop : (projectedRowTop ?? currentRowTop),
          height: VIRTUAL_ROW_HEIGHT
        }}
      >
        {row}
      </div>
    )
    return parts
  }

  return (
    <main
      ref={listRef}
      data-testid="thread-list"
      data-view={view}
      data-thread-count={threads.length}
      data-has-more={hasMore || undefined}
      data-virtualized="true"
      tabIndex={-1}
      className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2 outline-none ${
        readerOpen ? 'hidden' : ''
      }`}
      aria-label="Conversation list"
      onScroll={(event) => {
        const list = event.currentTarget
        pendingScrollTopRef.current = list.scrollTop
        if (
          hasMore &&
          !loadingMore &&
          list.scrollHeight - list.scrollTop - list.clientHeight <= list.clientHeight * 2
        ) {
          onLoadMore()
        }
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setScrollTop(pendingScrollTopRef.current)
        })
      }}
    >
      {threads.length === 0 && (
        <div
          data-testid={loadingInitial ? 'thread-list-loading-initial' : undefined}
          className="flex h-full items-center justify-center text-ink-faint"
          role={loadingInitial ? 'status' : undefined}
        >
          {loadingInitial ? 'Loading conversations…' : syncing ? 'Syncing your inbox…' : EMPTY_TEXT[view]}
        </div>
      )}
      <div
        ref={virtualContentRef}
        className={`relative ${projected ? 'app-thread-virtual-collapse' : ''}`}
        style={{ height: projectedVirtualHeight }}
      >
        {dividerBeforeIndex !== undefined && sectionDivider && (
          <div
            data-testid="thread-section-divider"
            data-section="gmail"
            className={`absolute right-0 left-0 flex h-[34px] items-center gap-3 px-7 text-[11px] font-semibold tracking-wide text-ink-faint uppercase ${
              projected?.dividerBeforeIndex !== undefined ? 'app-thread-position-shift' : ''
            }`}
            style={{
              top:
                projected?.dividerBeforeIndex === undefined
                  ? layout[dividerBeforeIndex]?.top
                  : projected.layout[projected.dividerBeforeIndex]?.top
            }}
          >
            <span className="h-px flex-1 bg-edge" />
            <span>{sectionDivider.label}</span>
            <span className="h-px flex-1 bg-edge" />
          </div>
        )}
        {mountedEntries.flatMap(renderThread)}
      </div>
      {loadingMore && (
        <div
          data-testid="thread-list-loading"
          className="flex h-8 items-center justify-center text-xs text-ink-faint"
          role="status"
        >
          Loading more…
        </div>
      )}
    </main>
  )
})
