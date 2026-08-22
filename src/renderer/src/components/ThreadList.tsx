import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MailLabel } from '../../../shared/mail'
import { dateGroup } from '../dateGroup'
import type { DisplayThread } from '../mailDisplay'

const LABEL_PALETTE = [
  { backgroundColor: '#44351b', borderColor: '#765b26', color: '#ffd789' },
  { backgroundColor: '#193b4a', borderColor: '#28647d', color: '#8cdbff' },
  { backgroundColor: '#263d2a', borderColor: '#3f6a48', color: '#a9e8b3' },
  { backgroundColor: '#402b43', borderColor: '#704a76', color: '#e6abe9' },
  { backgroundColor: '#452a2d', borderColor: '#75464b', color: '#ffadb3' },
  { backgroundColor: '#28334c', borderColor: '#465985', color: '#b8c9ff' }
] as const

function labelColor(labelId: string): (typeof LABEL_PALETTE)[number] {
  let hash = 0
  for (const character of labelId) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length]
}

function ThreadLabels({
  labelIds,
  labelsById
}: {
  labelIds: readonly string[]
  labelsById: ReadonlyMap<string, MailLabel>
}): React.JSX.Element {
  return (
    <>
      {labelIds.map((labelId) => {
        const label = labelsById.get(labelId)
        return label ? (
          <span
            key={labelId}
            data-testid="label-chip"
            title={label.name}
            className="max-w-24 flex-none truncate rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={labelColor(labelId)}
          >
            {label.name}
          </span>
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

interface ThreadListProps {
  threads: DisplayThread[]
  view: 'inbox' | 'snoozed'
  syncing: boolean
  readerOpen: boolean
  selectedIndex: number
  selectedIds: ReadonlySet<string>
  exitingThreadIds: ReadonlySet<string>
  labelsById: ReadonlyMap<string, MailLabel>
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  onExtendSelection: (index: number) => void
  onOpen: (index: number) => void
}

const VIRTUALIZE_AT = 500
const VIRTUAL_ROW_HEIGHT = 46
const VIRTUAL_GROUP_HEIGHT = 44
const VIRTUAL_OVERSCAN_PX = VIRTUAL_ROW_HEIGHT * 12

interface VirtualThreadEntry {
  index: number
  top: number
  height: number
  group: ReturnType<typeof dateGroup>
  showGroup: boolean
}

function virtualLayout(threads: readonly DisplayThread[], view: 'inbox' | 'snoozed'): VirtualThreadEntry[] {
  let top = 0
  let previousGroup: ReturnType<typeof dateGroup> | undefined
  return threads.map((thread, index) => {
    const group = dateGroup(thread)
    const showGroup = view === 'inbox' && group !== previousGroup
    const height = VIRTUAL_ROW_HEIGHT + (showGroup ? VIRTUAL_GROUP_HEIGHT : 0)
    const entry = { index, top, height, group, showGroup }
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
    syncing,
    readerOpen,
    selectedIndex,
    selectedIds,
    exitingThreadIds,
    labelsById,
    selectedRowRef,
    onExtendSelection,
    onOpen
  } = props
  const listRef = useRef<HTMLElement | null>(null)
  const virtualContentRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(800)
  const virtualized = threads.length >= VIRTUALIZE_AT
  const layout = useMemo(() => virtualLayout(threads, view), [threads, view])
  const projected = useMemo(() => {
    if (!virtualized || exitingThreadIds.size === 0) return null
    const survivingThreads = threads.filter((thread) => !exitingThreadIds.has(thread.id))
    const projectedLayout = virtualLayout(survivingThreads, view)
    const byThreadId = new Map<string, VirtualThreadEntry>()
    for (const entry of projectedLayout) byThreadId.set(survivingThreads[entry.index].id, entry)
    return { threads: survivingThreads, layout: projectedLayout, byThreadId }
  }, [exitingThreadIds, threads, view, virtualized])
  const projectedGroupTops = useMemo(() => {
    const tops = new Map<VirtualThreadEntry['group'], number>()
    for (const entry of projected?.layout ?? []) {
      if (entry.showGroup) tops.set(entry.group, entry.top)
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
    if (!virtualized) return []
    const current = visibleEntries(layout, scrollTop, viewportHeight)
    if (!projected) return current
    const mountedByIndex = new Map(current.map((entry) => [entry.index, entry]))
    for (const entry of visibleEntries(projected.layout, scrollTop, viewportHeight)) {
      const thread = projected.threads[entry.index]
      const currentEntry = layoutByThreadId.get(thread.id)
      if (currentEntry) mountedByIndex.set(currentEntry.index, currentEntry)
    }
    return [...mountedByIndex.values()].sort((left, right) => left.index - right.index)
  }, [layout, layoutByThreadId, projected, scrollTop, viewportHeight, virtualized])

  useEffect(() => {
    const list = listRef.current
    if (!list || !virtualized) return
    const measure = (): void => setViewportHeight(list.clientHeight || 800)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [virtualized])

  useLayoutEffect(() => {
    const list = listRef.current
    const selectedThread = threads[selectedIndex]
    const selected =
      (selectedThread ? projected?.byThreadId.get(selectedThread.id) : undefined) ?? layout[selectedIndex]
    if (!list || !selected || !virtualized || readerOpen) return

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
  }, [layout, projected, readerOpen, selectedIndex, threads, viewportHeight, virtualized])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  const renderThread = (entry: VirtualThreadEntry): React.JSX.Element[] => {
    const { index, group, showGroup } = entry
    const thread = threads[index]
    const selected = index === selectedIndex
    const checked = selectedIds.has(thread.id)
    const exiting = exitingThreadIds.has(thread.id)
    const projectedEntry = projected?.byThreadId.get(thread.id)
    const currentRowTop = entry.top + (showGroup ? VIRTUAL_GROUP_HEIGHT : 0)
    const projectedRowTop = projectedEntry
      ? projectedEntry.top + (projectedEntry.showGroup ? VIRTUAL_GROUP_HEIGHT : 0)
      : undefined
    let groupSurvives = false
    if (exiting && showGroup) {
      for (let nextIndex = index + 1; nextIndex < threads.length; nextIndex++) {
        if (dateGroup(threads[nextIndex]) !== group) break
        if (!exitingThreadIds.has(threads[nextIndex].id)) {
          groupSurvives = true
          break
        }
      }
    }
    const collapseGroup = exiting && showGroup && !groupSurvives
    const groupHeader = showGroup ? (
      <div
        key="group"
        data-testid="thread-date-group"
        className={`select-none px-8 text-xs font-semibold text-ink-faint ${
          virtualized ? 'h-[44px] pt-5 pb-2' : 'pt-5 pb-2'
        }`}
      >
        {group}
      </div>
    ) : null
    const row = (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global
      // biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is global
      <div
        key="row"
        ref={selected ? selectedRowRef : null}
        data-testid="thread-row"
        data-thread-index={index}
        data-thread-id={thread.id}
        data-selected={selected || undefined}
        data-checked={checked || undefined}
        data-unread={thread.unread || undefined}
        data-starred={thread.starred || undefined}
        data-exiting={exiting || undefined}
        className={`flex cursor-default select-none items-center gap-3.5 border-l-[3px] pr-7 pl-5 ${
          virtualized ? 'h-[46px]' : 'py-[11px]'
        } ${selected ? 'border-l-accent' : 'border-l-transparent'} ${
          checked ? 'bg-accent/[0.12]' : selected ? 'bg-accent/[0.07]' : ''
        } ${exiting ? 'app-thread-exit' : ''}`}
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
          <ThreadLabels labelIds={thread.labelIds} labelsById={labelsById} />
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
          <span className="app-thread-time min-w-[70px] text-right tabular-nums">{thread.at}</span>
        </span>
      </div>
    )
    if (virtualized) {
      const projectedGroupTop = projectedGroupTops.get(group)
      const groupRemoved = projected !== null && projectedGroupTop === undefined
      const parts: React.JSX.Element[] = []
      if (showGroup) {
        parts.push(
          <div
            key={`group:${group}`}
            data-testid="thread-date-group"
            className={`absolute right-0 left-0 h-[44px] px-8 pt-5 pb-2 text-xs font-semibold text-ink-faint ${
              projectedGroupTop !== undefined ? 'app-thread-position-shift' : ''
            } ${groupRemoved ? 'app-thread-exit' : ''}`}
            style={{ top: projectedGroupTop ?? entry.top }}
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
    return [
      <div key={thread.id} className="overflow-x-clip">
        {!collapseGroup && groupHeader}
        <div
          className={
            exiting
              ? `app-thread-exit-shell ${collapseGroup ? 'app-thread-exit-shell-with-group' : ''}`
              : undefined
          }
        >
          <div className={exiting ? 'app-thread-exit-content' : undefined}>
            {collapseGroup && groupHeader}
            {row}
          </div>
        </div>
      </div>
    ]
  }

  return (
    <main
      ref={listRef}
      data-testid="thread-list"
      data-thread-count={threads.length}
      data-virtualized={virtualized || undefined}
      className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2 ${readerOpen ? 'hidden' : ''}`}
      aria-label="Conversation list"
      onScroll={
        virtualized
          ? (event) => {
              pendingScrollTopRef.current = event.currentTarget.scrollTop
              if (frameRef.current !== null) return
              frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null
                setScrollTop(pendingScrollTopRef.current)
              })
            }
          : undefined
      }
    >
      {threads.length === 0 && (
        <div className="flex h-full items-center justify-center text-ink-faint">
          {syncing ? 'Syncing your inbox…' : view === 'snoozed' ? 'Nothing snoozed' : 'Inbox empty'}
        </div>
      )}
      {virtualized ? (
        <div
          ref={virtualContentRef}
          className={`relative ${projected ? 'app-thread-virtual-collapse' : ''}`}
          style={{ height: projectedVirtualHeight }}
        >
          {mountedEntries.flatMap(renderThread)}
        </div>
      ) : (
        layout.flatMap(renderThread)
      )}
    </main>
  )
})
