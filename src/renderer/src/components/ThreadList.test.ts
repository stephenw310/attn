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
