// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { MailView } from '../list/mailDisplay'
import type { SplitData } from './useSplits'
import { useViewNavigation } from './useViewNavigation'
import type { ViewRecordStore } from './useViewRecords'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function records(): ViewRecordStore {
  const saved: string[] = []
  const store = {
    viewRecords: { current: new Map() },
    splitRecords: { current: new Map() },
    pendingViewRestore: { current: null },
    pendingSplitRestore: { current: null },
    searchReturn: { current: null },
    outboxReturn: { current: { view: 'inbox', selectedIndex: 0, readerOpen: false } },
    captureRecord: () => ({ rowId: null, index: 0, scrollTop: 0 }),
    saveActiveViewRecord: vi.fn(() => saved.push('saved')),
    saveAccountSnapshot: vi.fn()
  }
  return store as unknown as ViewRecordStore
}

function splits(activeSplitId: string | null, ids: readonly string[]): SplitData {
  const data = {
    state: ids.length > 0 ? { revision: 1, splits: ids.map((id) => ({ id, name: id })) } : null,
    activeSplitId,
    setActiveSplitId: vi.fn((id: string) => {
      data.activeSplitId = id
    }),
    save: vi.fn(),
    setNotify: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    restorePreset: vi.fn()
  }
  return data as unknown as SplitData
}

async function mount(overrides: Record<string, unknown> = {}) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { findThreadInView: vi.fn(async () => ({ rows: [] })) } } as unknown as Window['attn']
  })
  const calls: string[] = []
  const store = records()
  const splitData = splits('important', ['important', 'other'])
  const state = {
    view: 'inbox' as MailView,
    viewRef: { current: 'inbox' as MailView },
    searchOpen: { current: false },
    selectedIndex: 0,
    readerOpen: false
  }
  const root = createRoot(document.createElement('div'))
  const navs: ReturnType<typeof useViewNavigation>[] = []
  function Harness(): null {
    navs.push(
      useViewNavigation({
        view: state.view,
        viewRef: state.viewRef,
        applyView: (next) => {
          state.viewRef.current = next
          state.view = next
          calls.push(`view:${next}`)
        },
        records: store,
        splits: splitData,
        inlineComposerRef: createRef(),
        searchOpenRef: state.searchOpen,
        closeSearch: () => calls.push('closeSearch'),
        viewRowsLoaded: false,
        threads: [],
        mailboxThreads: [{ id: 'thread-1' }, { id: 'thread-2' }],
        realThreads: null,
        realDrafts: [],
        realOutbox: [],
        pagedView: null,
        activePageState: undefined,
        threadPagination: {},
        loadMoreThreads: vi.fn(async () => {}),
        loadedInboxSplitId: null,
        loadedInboxSplitStale: false,
        activateInboxSplitCache: vi.fn(),
        inboxSplitRevision: 1,
        mailRevision: 1,
        selectedIndex: state.selectedIndex,
        readerOpen: state.readerOpen,
        clearSelection: () => calls.push('clearSelection'),
        invalidateConversations: () => calls.push('invalidateConversations'),
        refreshCachedThreadView: vi.fn(async () => {}),
        setSelectedIndex: (next) => calls.push(`index:${String(next)}`),
        setReaderOpen: (open) => calls.push(`reader:${open}`),
        closePickers: () => calls.push('closePickers'),
        closeMove: () => calls.push('closeMove'),
        closeSettings: () => calls.push('closeSettings'),
        setDetachedDraftThread: () => calls.push('detach:null'),
        listElRef: createRef<HTMLElement>(),
        selectedIndexRef: { current: state.selectedIndex },
        readerOpenRef: { current: state.readerOpen },
        selectedThreadIdRef: { current: 'thread-1' },
        selectedDraftIdRef: { current: null },
        ...overrides
      })
    )
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    calls,
    store,
    splitData,
    state,
    nav: () => navs.at(-1) as ReturnType<typeof useViewNavigation>,
    render: async () => {
      await act(async () => root.render(createElement(Harness)))
    },
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('a view switch saves the list it leaves and queues the record for the one it enters', async () => {
  const harness = await mount()
  try {
    harness.store.viewRecords.current.set('starred', { rowId: 'thread-9', index: 3, scrollTop: 60 })
    await act(async () => harness.nav().switchView('starred'))
    expect(harness.store.saveActiveViewRecord).toHaveBeenCalledTimes(1)
    expect(harness.store.pendingViewRestore.current).toEqual({
      view: 'starred',
      record: { rowId: 'thread-9', index: 3, scrollTop: 60 }
    })
    expect(harness.state.viewRef.current).toBe('starred')
    expect(harness.calls).toContain('view:starred')
    expect(harness.calls).toContain('index:3')
    expect(harness.calls).toContain('reader:false')
    // Inbox and Starred share the 'normal' reader projection, so the warm
    // conversation cache survives the switch.
    expect(harness.calls).not.toContain('invalidateConversations')
  } finally {
    await harness.unmount()
  }
})

test('a switch into Trash drops the conversation cache its projection cannot serve', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.nav().switchView('trash'))
    expect(harness.calls).toContain('invalidateConversations')
  } finally {
    await harness.unmount()
  }
})

test('leaving search restores the stashed record instead of the view record', async () => {
  const harness = await mount()
  try {
    harness.state.searchOpen.current = true
    harness.store.searchReturn.current = { rowId: 'thread-4', index: 2, scrollTop: 30 }
    harness.store.viewRecords.current.set('inbox', { rowId: 'other', index: 9, scrollTop: 0 })
    await act(async () => harness.nav().switchView('inbox'))
    expect(harness.calls).toContain('closeSearch')
    expect(harness.store.searchReturn.current).toBeNull()
    expect(harness.store.pendingViewRestore.current?.record.rowId).toBe('thread-4')
    // The list it leaves is the search results, so nothing is saved for it.
    expect(harness.store.saveActiveViewRecord).not.toHaveBeenCalled()
  } finally {
    await harness.unmount()
  }
})

test('a split switch saves the row on screen now and queues the target split', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.nav().switchSplit('other'))
    expect(harness.store.splitRecords.current.get('important')).toMatchObject({
      rowId: 'thread-1',
      index: 0,
      loadedRows: 2
    })
    expect(harness.store.pendingSplitRestore.current?.id).toBe('other')
    expect(harness.splitData.setActiveSplitId).toHaveBeenCalledWith('other')
    // A split switch is not a mailbox switch: the move picker is not its overlay.
    expect(harness.calls).not.toContain('closeMove')

    // Re-selecting the active split is a no-op.
    const before = harness.splitData.setActiveSplitId
    await act(async () => harness.nav().switchSplit('other'))
    expect(before).toHaveBeenCalledTimes(1)
  } finally {
    await harness.unmount()
  }
})

test('moveSplit wraps around the strip', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.nav().moveSplit(-1))
    expect(harness.splitData.setActiveSplitId).toHaveBeenCalledWith('other')
  } finally {
    await harness.unmount()
  }
})

test('the outbox remembers the list it covered and returns to it', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.nav().openOutbox())
    expect(harness.store.outboxReturn.current).toEqual({
      view: 'inbox',
      selectedIndex: 0,
      readerOpen: false
    })
    expect(harness.state.viewRef.current).toBe('outbox')

    await act(async () => harness.nav().closeOutbox())
    expect(harness.state.viewRef.current).toBe('inbox')
  } finally {
    await harness.unmount()
  }
})
