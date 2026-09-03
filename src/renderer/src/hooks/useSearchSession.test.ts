// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { ThreadRow } from '../../../shared/mail'
import type { SearchResponse } from '../../../shared/searchQuery'
import { SEARCH_DEBOUNCE_MS } from '../tuning'
import { useSearchSession } from './useSearchSession'
import type { ViewRecordStore } from './useViewRecords'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  vi.useRealTimers()
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function row(id: string): ThreadRow {
  return {
    id,
    fromDisplay: 'Sender',
    subject: id,
    snippet: '',
    lastMsgAt: 1,
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    hasDraft: false,
    labelIds: []
  }
}

function response(rows: ThreadRow[]): SearchResponse {
  return {
    rows,
    drafts: [],
    coverage: {
      headersComplete: true,
      headersCapped: false,
      indexComplete: true,
      attachmentFlagsComplete: true,
      bodiesOnDemand: false
    },
    partial: false
  }
}

function records(): ViewRecordStore {
  return {
    viewRecords: { current: new Map() },
    splitRecords: { current: new Map() },
    pendingViewRestore: { current: null },
    pendingSplitRestore: { current: null },
    searchReturn: { current: null },
    outboxReturn: { current: { view: 'inbox', selectedIndex: 0, readerOpen: false } },
    captureRecord: () => ({ rowId: null, index: 0, scrollTop: 0 }),
    saveActiveViewRecord: () => {},
    saveAccountSnapshot: () => {}
  } as unknown as ViewRecordStore
}

async function mount(searchImpl: (query: string) => Promise<SearchResponse>) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { search: vi.fn(searchImpl) } } as unknown as Window['attn']
  })
  const store = records()
  const state = {
    open: true,
    query: 'alpha',
    selectedIndex: 0,
    selectedThreadId: { current: null as string | null },
    selectedDraftId: { current: null as string | null }
  }
  const root = createRoot(document.createElement('div'))
  const sessions: ReturnType<typeof useSearchSession>[] = []
  function Harness(): null {
    sessions.push(
      useSearchSession({
        open: state.open,
        setOpen: (open) => {
          state.open = open
        },
        openRef: { current: state.open },
        query: state.query,
        setQuery: (query) => {
          state.query = query
        },
        view: 'inbox',
        account: 'a@attn.test',
        mailRevision: 1,
        mailChangeSource: null,
        online: true,
        labels: [],
        readerOpen: false,
        composerCovering: false,
        records: store,
        setSelectedIndex: (next) => {
          state.selectedIndex = typeof next === 'function' ? next(state.selectedIndex) : next
        },
        selectedIndex: state.selectedIndex,
        finishReaderClose: () => {},
        closeMove: () => {},
        reconnectGoogle: async () => null,
        listElRef: createRef<HTMLElement>(),
        readerOpenRef: { current: false },
        selectedIndexRef: { current: state.selectedIndex },
        selectedThreadIdRef: state.selectedThreadId,
        selectedDraftIdRef: state.selectedDraftId
      })
    )
    return null
  }
  const render = async (): Promise<void> => {
    await act(async () => root.render(createElement(Harness)))
  }
  await render()
  return {
    state,
    store,
    render,
    session: () => sessions.at(-1) as ReturnType<typeof useSearchSession>,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('merges local hits ahead of the Gmail-only remainder and pins the cursor by identity', async () => {
  vi.useFakeTimers()
  const harness = await mount(async () => response([row('thread-1'), row('thread-2')]))
  try {
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(harness.session().rowIds).toEqual(['thread-1', 'thread-2'])
    // Nothing came from Gmail, so there is no divider to draw.
    expect(harness.session().sectionDivider).toBeUndefined()

    // Move the cursor to the second row, then let the backing list refresh
    // with that row first. The cursor follows the row, not the index.
    harness.state.selectedIndex = 1
    await harness.render()
    expect(harness.state.selectedThreadId.current).toBe('thread-2')

    Object.defineProperty(window, 'attn', {
      configurable: true,
      value: {
        mail: { search: vi.fn(async () => response([row('thread-2'), row('thread-1')])) }
      } as unknown as Window['attn']
    })
    harness.state.query = 'alpha '
    await harness.render()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(harness.state.selectedIndex).toBe(0)
    expect(harness.state.selectedThreadId.current).toBe('thread-2')
  } finally {
    await harness.unmount()
  }
})

test('opening search stashes the pre-search record and clearing it queues the restore', async () => {
  vi.useFakeTimers()
  const harness = await mount(async () => response([]))
  try {
    harness.state.selectedThreadId.current = 'thread-7'
    // openSearch refuses while search is already open — it focuses the field
    // instead — so the stash under test is the one a previous open left.
    await act(async () => harness.session().openSearch())
    expect(harness.store.searchReturn.current).toBeNull()

    harness.store.searchReturn.current = { rowId: 'thread-7', index: 4, scrollTop: 90 }
    await act(async () => harness.session().clearSearch())
    expect(harness.store.searchReturn.current).toBeNull()
    expect(harness.store.pendingViewRestore.current).toEqual({
      view: 'inbox',
      record: { rowId: 'thread-7', index: 4, scrollTop: 90 }
    })
    expect(harness.state.selectedThreadId.current).toBe('thread-7')
    expect(harness.state.selectedIndex).toBe(4)
    expect(harness.state.open).toBe(false)
    expect(harness.state.query).toBe('')
  } finally {
    await harness.unmount()
  }
})

test('draft mode reports draft rows and suppresses the Gmail-wide search', async () => {
  vi.useFakeTimers()
  const harness = await mount(async () => ({
    ...response([]),
    drafts: [{ id: 'draft-1' }, { id: 'draft-2' }] as never
  }))
  try {
    harness.state.query = 'in:drafts'
    await harness.render()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(harness.session().draftMode).toBe(true)
    expect(harness.session().rowIds).toEqual(['draft-1', 'draft-2'])
    expect(harness.session().allEnabled).toBe(false)
    // A draft row is not a thread, so the reader's thread cursor stays clear.
    expect(harness.state.selectedThreadId.current).toBeNull()
  } finally {
    await harness.unmount()
  }
})
