// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { DisplayThread } from '../mailDisplay'
import { ThreadList } from './ThreadList'

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
    returned: false,
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
    onExtendSelection,
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
    returned: false,
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
    selectedRowRef: { current: null },
    onExtendSelection: (): void => {},
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
    expect(container.querySelectorAll('[data-testid="thread-row"]').length).toBeLessThan(100)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('includes list padding when scrolling a keyboard selection fully into view', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const offsetTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.getAttribute('data-testid') === 'thread-list' ? 100 : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
      return this.classList.contains('relative') ? 8 : 0
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
    returned: false,
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
    onExtendSelection: (): void => {},
    onOpen: (): void => {}
  }

  try {
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 0 })))
    await act(async () => root.render(createElement(ThreadList, { ...baseProps, selectedIndex: 3 })))

    const list = container.querySelector<HTMLElement>('[data-testid="thread-list"]')
    expect(list?.scrollTop).toBe(136)
  } finally {
    await act(async () => root.unmount())
    if (clientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor)
    } else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    if (offsetTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop')
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
