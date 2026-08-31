// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DisplayThread } from '../mailDisplay'
import { ThreadList } from './ThreadList'

it('does not call an unresolved Inbox split empty', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const props = {
    threads: [],
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIndex: 0,
    selectedIds: new Set<string>(),
    exitingThreadIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null },
    listRef: { current: null },
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () => root.render(createElement(ThreadList, { ...props, loadingInitial: true })))
    expect(container.textContent).toContain('Loading conversations…')
    expect(container.textContent).not.toContain('Inbox empty')
    expect(container.querySelector('[data-testid="thread-list-loading-initial"]')).not.toBeNull()

    await act(async () => root.render(createElement(ThreadList, { ...props, loadingInitial: false })))
    expect(container.textContent).toContain('Inbox empty')
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('loads the next page when keyboard selection approaches the loaded tail', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const threads: DisplayThread[] = Array.from({ length: 100 }, (_, index) => ({
    id: `thread-${index}`,
    from: `Sender ${index}`,
    subject: `Subject ${index}`,
    snippet: '',
    at: '9:30 AM',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: 100 - index
  }))
  const onLoadMore = vi.fn()
  const root = createRoot(document.createElement('div'))

  try {
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          threads,
          view: 'inbox',
          hasMore: true,
          loadingMore: false,
          syncing: false,
          readerOpen: false,
          selectedIndex: 80,
          selectedIds: new Set<string>(),
          exitingThreadIds: new Set<string>(),
          labelsById: new Map(),
          selectedRowRef: { current: null },
          listRef: { current: null },
          onExtendSelection: () => {},
          onLoadMore,
          onOpenLabel: () => {},
          onOpen: () => {}
        })
      )
    )
    expect(onLoadMore).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('keeps a manual scroll offset when a page is appended without moving the selection', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const makeThreads = (count: number): DisplayThread[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `thread-${index}`,
      from: `Sender ${index}`,
      subject: `Subject ${index}`,
      snippet: '',
      at: '9:30 AM',
      unread: false,
      starred: false,
      hasAttachment: false,
      snoozed: false,
      returned: false,
      followUpReturned: false,
      hasDraft: false,
      labelIds: [],
      lastMsgAt: count - index
    }))
  const container = document.createElement('div')
  const root = createRoot(container)
  const listRef = { current: null as HTMLElement | null }
  const baseProps = {
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIndex: 0,
    selectedIds: new Set<string>(),
    exitingThreadIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null },
    listRef,
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, threads: makeThreads(100) })))
    const list = listRef.current
    if (!list) throw new Error('thread list did not mount')
    list.scrollTop = 2_000

    await act(async () => root.render(createElement(ThreadList, { ...baseProps, threads: makeThreads(200) })))

    expect(list.scrollTop).toBe(2_000)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('skips the row tree when an unrelated parent update preserves its props', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let subjectReads = 0
  const thread: DisplayThread = {
    id: 'thread-1',
    from: 'Maya',
    get subject() {
      subjectReads++
      return 'Roadmap'
    },
    snippet: 'The latest plan',
    at: '9:30 AM',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: Date.now()
  }
  const selectedIds = new Set<string>()
  const exitingThreadIds = new Set<string>()
  const labelsById = new Map()
  const selectedRowRef = { current: null }
  const onExtendSelection = (): void => {}
  const onOpen = (): void => {}
  const props = {
    threads: [thread],
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIndex: 0,
    selectedIds,
    exitingThreadIds,
    labelsById,
    selectedRowRef,
    listRef: { current: null as HTMLElement | null },
    onExtendSelection,
    onOpenLabel: (): void => {},
    onOpen
  }
  const container = document.createElement('div')
  const root = createRoot(container)

  try {
    await act(async () => root.render(createElement(ThreadList, props)))
    const readsAfterFirstRender = subjectReads
    expect(readsAfterFirstRender).toBeGreaterThan(0)

    await act(async () => root.render(createElement(ThreadList, props)))
    expect(subjectReads).toBe(readsAfterFirstRender)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('windows large lists while keeping an offscreen keyboard selection mounted', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const threads: DisplayThread[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `thread-${index}`,
    from: `Sender ${index}`,
    subject: `Subject ${index}`,
    snippet: 'Windowed row',
    at: '9:30 AM',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: Date.now() - index * 60_000
  }))
  const container = document.createElement('div')
  const root = createRoot(container)
  const baseProps = {
    threads,
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIds: new Set<string>(),
    exitingThreadIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null as HTMLDivElement | null },
    listRef: { current: null as HTMLElement | null },
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 0 })))
    const list = container.querySelector('[data-testid="thread-list"]')
    expect(list?.getAttribute('data-thread-count')).toBe('1000')
    expect(list?.getAttribute('data-virtualized')).toBe('true')
    expect(container.querySelectorAll('[data-testid="thread-row"]').length).toBeLessThan(100)

    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 900 })))
    expect(
      container
        .querySelector('[data-testid="thread-row"][data-thread-index="900"]')
        ?.getAttribute('data-selected')
    ).toBe('true')
    expect(baseProps.selectedRowRef.current?.dataset.threadIndex).toBe('900')
    expect(container.querySelectorAll('[data-testid="thread-row"]').length).toBeLessThan(100)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('projects virtual rows into the space left by an exiting row without moving the cursor', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const now = Date.now()
  const threads: DisplayThread[] = Array.from({ length: 501 }, (_, index) => ({
    id: `thread-${index}`,
    from: `Sender ${index}`,
    subject: `Subject ${index}`,
    snippet: 'Windowed row',
    at: '9:30 AM',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: now - index * 1_000
  }))
  const container = document.createElement('div')
  const root = createRoot(container)
  const baseProps = {
    threads,
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null },
    listRef: { current: null as HTMLElement | null },
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          selectedIndex: 0,
          exitingThreadIds: new Set<string>()
        })
      )
    )
    const secondRow = container.querySelector<HTMLElement>(
      '[data-testid="thread-row"][data-thread-index="1"]'
    )
    const firstRow = container.querySelector<HTMLElement>('[data-testid="thread-row"][data-thread-index="0"]')
    const groupHeader = container.querySelector<HTMLElement>('[data-testid="thread-date-group"]')
    expect(secondRow?.closest<HTMLElement>('.absolute')?.style.top).toBe('90px')

    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          selectedIndex: 1,
          exitingThreadIds: new Set(['thread-0'])
        })
      )
    )
    const projectedSecondRow = container.querySelector<HTMLElement>(
      '[data-testid="thread-row"][data-thread-index="1"]'
    )
    expect(container.querySelector('[data-testid="thread-row"][data-thread-index="0"]')).toBe(firstRow)
    expect(firstRow?.getAttribute('data-exiting')).toBe('true')
    expect(projectedSecondRow?.getAttribute('data-selected')).toBe('true')
    expect(projectedSecondRow?.closest<HTMLElement>('.absolute')?.style.top).toBe('44px')
    expect(
      projectedSecondRow?.closest<HTMLElement>('.absolute')?.classList.contains('app-thread-position-shift')
    ).toBe(true)

    // The provider refresh commits the optimistic list after the transition.
    // Keep both the promoted row and its date header mounted through that
    // handoff so Electron never has a blank raster frame to flash.
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          threads: threads.slice(1),
          selectedIndex: 0,
          exitingThreadIds: new Set(['thread-0'])
        })
      )
    )
    const committedSecondRow = container.querySelector<HTMLElement>(
      '[data-testid="thread-row"][data-thread-index="0"]'
    )
    expect(committedSecondRow).toBe(projectedSecondRow)
    expect(container.querySelector('[data-testid="thread-date-group"]')).toBe(groupHeader)

    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          threads: threads.slice(1),
          selectedIndex: 0,
          exitingThreadIds: new Set<string>()
        })
      )
    )
    expect(container.querySelector('[data-testid="thread-row"][data-thread-index="0"]')).toBe(
      projectedSecondRow
    )
    expect(container.querySelector('[data-testid="thread-date-group"]')).toBe(groupHeader)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('keeps repeated date headers at distinct positions while projecting an exit', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const makeThread = (id: string, lastMsgAt: number): DisplayThread => ({
    id,
    from: id,
    subject: id,
    snippet: '',
    at: '',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt
  })
  const threads = [
    makeThread('today-first', today.getTime()),
    makeThread('old', new Date(2013, 0, 1).getTime()),
    makeThread('today-second', today.getTime() - 60_000)
  ]
  const container = document.createElement('div')
  const root = createRoot(container)

  try {
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          threads,
          view: 'search',
          syncing: false,
          readerOpen: false,
          selectedIndex: 0,
          selectedIds: new Set<string>(),
          exitingThreadIds: new Set(['old']),
          labelsById: new Map(),
          selectedRowRef: { current: null },
          listRef: { current: null },
          onExtendSelection: () => {},
          onOpenLabel: () => {},
          onOpen: () => {}
        })
      )
    )

    const headerTops = [...container.querySelectorAll<HTMLElement>('[data-testid="thread-date-group"]')].map(
      (header) => header.style.top
    )
    expect(new Set(headerTops).size).toBe(headerTops.length)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

// jsdom has no layout, so model the real geometry the effect measures: the list
// sits below a header, and the virtual sizer starts one padding step into the
// list's scroll content. Measuring the sizer against anything but the list --
// `offsetTop` resolves to <body>, because <main> is statically positioned --
// folds LIST_VIEWPORT_TOP into the scroll math and fails this test.
const LIST_VIEWPORT_TOP = 57
const LIST_PADDING_TOP = 8
const LIST_CLIENT_HEIGHT = 100

it('measures the sizer against the list when scrolling a selection into view', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const rectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const offsetTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.getAttribute('data-testid') === 'thread-list' ? LIST_CLIENT_HEIGHT : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (this.getAttribute('data-testid') === 'thread-list') return { top: LIST_VIEWPORT_TOP } as DOMRect
      if (this.classList.contains('relative')) {
        const scrollTop = this.closest<HTMLElement>('[data-testid="thread-list"]')?.scrollTop ?? 0
        return { top: LIST_VIEWPORT_TOP + LIST_PADDING_TOP - scrollTop } as DOMRect
      }
      return { top: 0 } as DOMRect
    }
  })
  // Absolute document offsets must not be what the effect reads.
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
      return this.classList.contains('relative') ? LIST_VIEWPORT_TOP + LIST_PADDING_TOP : LIST_VIEWPORT_TOP
    }
  })
  const todayAtNoon = new Date()
  todayAtNoon.setHours(12, 0, 0, 0)
  const threads: DisplayThread[] = Array.from({ length: 500 }, (_, index) => ({
    id: `thread-${index}`,
    from: `Sender ${index}`,
    subject: `Subject ${index}`,
    snippet: 'Windowed row',
    at: '9:30 AM',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: todayAtNoon.getTime() - index * 60_000
  }))
  const container = document.createElement('div')
  const root = createRoot(container)
  const baseProps = {
    threads,
    view: 'inbox' as const,
    syncing: false,
    readerOpen: false,
    selectedIds: new Set<string>(),
    exitingThreadIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null },
    listRef: { current: null as HTMLElement | null },
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 0 })))
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 3 })))

    // Row 3 sits at 182 in layout coordinates and is 46 tall, so pulling its
    // bottom to the viewport floor lands at 8 + 182 + 46 - 100. Reading the
    // sizer's document offset instead would scroll a header-height too far.
    const list = container.querySelector<HTMLElement>('[data-testid="thread-list"]')
    expect(list?.scrollTop).toBe(LIST_PADDING_TOP + 182 + 46 - LIST_CLIENT_HEIGHT)
  } finally {
    await act(async () => root.unmount())
    if (clientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor)
    } else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    if (rectDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectDescriptor)
    } else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    if (offsetTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop')
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it("shows the 'Follow up' heading only in the inbox, which hoists the tier", async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const thread = (id: string, followUpReturned: boolean): DisplayThread => ({
    id,
    from: `Sender ${id}`,
    subject: `Subject ${id}`,
    snippet: '',
    at: '9:30 AM',
    unread: false,
    starred: true,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned,
    hasDraft: false,
    labelIds: [],
    lastMsgAt: Date.now()
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  const baseProps = {
    syncing: false,
    readerOpen: false,
    selectedIndex: 0,
    selectedIds: new Set<string>(),
    exitingThreadIds: new Set<string>(),
    labelsById: new Map(),
    selectedRowRef: { current: null },
    listRef: { current: null },
    onExtendSelection: (): void => {},
    onOpenLabel: (): void => {},
    onOpen: (): void => {}
  }
  const groups = (): string[] =>
    [...container.querySelectorAll('[data-testid="thread-date-group"]')].map((node) => node.textContent ?? '')

  try {
    // Every non-inbox view sorts follow-up threads by date; the heading would
    // split a same-day group mid-list at the row's position (PR #101 review).
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          view: 'starred' as const,
          threads: [thread('a', false), thread('b', true), thread('c', false)]
        })
      )
    )
    expect(groups()).toEqual(['Today'])

    // The inbox leads with the hoisted tier under its own heading.
    await act(async () =>
      root.render(
        createElement(ThreadList, {
          ...baseProps,
          view: 'inbox' as const,
          threads: [thread('b', true), thread('a', false), thread('c', false)]
        })
      )
    )
    expect(groups()).toEqual(['Follow up', 'Today'])
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
