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
  const virtualHeight =
    layout.length > 0 ? layout[layout.length - 1].top + layout[layout.length - 1].height : 0
  const mountedEntries = useMemo(
    () => (virtualized ? visibleEntries(layout, scrollTop, viewportHeight) : []),
    [layout, scrollTop, viewportHeight, virtualized]
  )

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
    const contentTop = virtualContentRef.current?.offsetTop ?? 0
    const selected = layout[selectedIndex]
    if (!list || !selected || !virtualized || readerOpen) return

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
  }, [layout, readerOpen, selectedIndex, viewportHeight, virtualized])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    []
  )

  const renderThread = (entry: VirtualThreadEntry): React.JSX.Element => {
    const { index, group, showGroup } = entry
    const thread = threads[index]
    const selected = index === selectedIndex
    const checked = selectedIds.has(thread.id)
    return (
      <div
        key={thread.id}
        className={`overflow-x-clip ${virtualized ? 'absolute right-0 left-0' : ''}`}
        style={virtualized ? { top: entry.top, height: entry.height } : undefined}
      >
        {showGroup && (
          <div
            data-testid="thread-date-group"
            className={`select-none px-8 text-xs font-semibold text-ink-faint ${
              virtualized ? 'h-[44px] pt-5 pb-2' : 'pt-5 pb-2'
            }`}
          >
            {group}
          </div>
        )}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is global */}
        <div
          ref={selected && !virtualized ? selectedRowRef : null}
          data-testid="thread-row"
          data-thread-index={index}
          data-selected={selected || undefined}
          data-checked={checked || undefined}
          data-unread={thread.unread || undefined}
          data-exiting={exitingThreadIds.has(thread.id) || undefined}
          className={`flex cursor-default select-none items-center gap-3.5 border-l-[3px] pr-7 pl-5 ${
            virtualized ? 'h-[46px]' : 'py-[11px]'
          } ${selected ? 'border-l-accent' : 'border-l-transparent'} ${
            checked ? 'bg-accent/[0.12]' : selected ? 'bg-accent/[0.07]' : ''
          } ${exitingThreadIds.has(thread.id) ? 'app-thread-exit' : ''}`}
          onClick={(event) => (event.shiftKey ? onExtendSelection(index) : onOpen(index))}
        >
          <span className="flex size-4 flex-none items-center justify-center self-center" aria-hidden>
            {checked ? (
              <span className="flex size-4 items-center justify-center rounded-[4px] bg-accent text-[11px] font-bold text-ground">
                ✓
              </span>
            ) : (
              <span
                className={`size-1.5 rounded-full ${
                  thread.unread ? 'bg-accent shadow-[0_0_6px_rgba(255,178,36,0.45)]' : 'bg-transparent'
                }`}
              />
            )}
          </span>
          <span
            data-testid="thread-sender"
            className={`w-52 flex-none overflow-hidden text-ellipsis whitespace-nowrap ${
              thread.unread ? 'font-semibold text-ink' : 'text-ink-dim'
            }`}
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
            {thread.starred && (
              <span className="flex-none text-star" title="Starred">
                ★
              </span>
            )}
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              <span
                data-testid="thread-subject"
                className={thread.unread ? 'font-semibold text-ink' : 'text-ink-dim'}
              >
                {thread.subject}
              </span>
              <span data-testid="thread-snippet"> — {thread.snippet}</span>
            </span>
          </span>
          <span className="flex flex-none items-center gap-2.5 text-xs">
            <ThreadStatusChips thread={thread} />
            {thread.hasAttachment && <span title="Has attachment">📎</span>}
            <span
              className={`min-w-[70px] text-right tabular-nums ${
                thread.unread ? 'font-medium text-accent' : 'text-ink-faint'
              }`}
            >
              {thread.at}
            </span>
          </span>
        </div>
      </div>
    )
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
        <div ref={virtualContentRef} className="relative" style={{ height: virtualHeight }}>
          {mountedEntries.map(renderThread)}
        </div>
      ) : (
        layout.map(renderThread)
      )}
    </main>
  )
})
