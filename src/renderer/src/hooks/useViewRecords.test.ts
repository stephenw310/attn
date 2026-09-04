// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { clearAccountView, readAccountView } from '../accountViewMemory'
import type { MailView } from '../list/mailDisplay'
import { useViewRecords } from './useViewRecords'

const ACCOUNT = 'records@attn.test'

afterEach(() => clearAccountView(ACCOUNT))

interface Harness {
  store: ReturnType<typeof useViewRecords>
  view: React.RefObject<MailView>
  searchOpen: React.RefObject<boolean>
  readerOpen: React.RefObject<boolean>
  activeSplitId: React.RefObject<string | null>
  selectedIndex: React.RefObject<number>
  selectedThreadId: React.RefObject<string | null>
  selectedDraftId: React.RefObject<string | null>
  loadedRows: React.RefObject<number>
  listEl: { current: HTMLElement | null }
  unmount: () => Promise<void>
}

async function mount(restored: Parameters<typeof useViewRecords>[0]['restored'] = null): Promise<Harness> {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const refs = {
    view: { current: 'inbox' as MailView },
    searchOpen: { current: false },
    readerOpen: { current: false },
    activeSplitId: { current: null as string | null },
    selectedIndex: { current: 0 },
    selectedThreadId: { current: null as string | null },
    selectedDraftId: { current: null as string | null },
    loadedRows: { current: 0 },
    listEl: createRef<HTMLElement>() as { current: HTMLElement | null }
  }
  const root = createRoot(document.createElement('div'))
  let store: ReturnType<typeof useViewRecords> | undefined
  function Component(): null {
    store = useViewRecords({ account: ACCOUNT, restored, ...refs })
    return null
  }
  await act(async () => root.render(createElement(Component)))
  if (!store) throw new Error('hook state was not captured')
  return {
    ...refs,
    store,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('captures the visible cursor and keeps a hidden list its last offset', async () => {
  const harness = await mount()
  const list = document.createElement('div')
  Object.defineProperty(list, 'scrollTop', { configurable: true, value: 120, writable: true })
  harness.listEl.current = list
  try {
    harness.selectedThreadId.current = 'thread-1'
    harness.selectedIndex.current = 3
    harness.loadedRows.current = 50
    expect(harness.store.captureRecord()).toEqual({ rowId: 'thread-1', index: 3, scrollTop: 120 })

    harness.store.saveActiveViewRecord()
    expect(harness.store.viewRecords.current.get('inbox')).toEqual({
      rowId: 'thread-1',
      index: 3,
      scrollTop: 120,
      loadedRows: 50
    })

    // While the reader is open the list is display:none and reads 0; the saved
    // offset must survive that rather than being clobbered.
    harness.readerOpen.current = true
    list.scrollTop = 0
    harness.store.saveActiveViewRecord()
    expect(harness.store.viewRecords.current.get('inbox')?.scrollTop).toBe(120)

    // The outbox is a covering view, not a saved one.
    harness.view.current = 'outbox'
    harness.store.saveActiveViewRecord()
    expect(harness.store.viewRecords.current.has('outbox')).toBe(false)
  } finally {
    await harness.unmount()
  }
})

test('the account snapshot takes the pre-search state while search is open', async () => {
  const harness = await mount()
  try {
    harness.activeSplitId.current = 'important'
    harness.searchOpen.current = true
    harness.store.searchReturn.current = { rowId: 'thread-9', index: 7, scrollTop: 42 }
    harness.loadedRows.current = 25
    harness.store.saveAccountSnapshot()

    const saved = readAccountView(ACCOUNT)
    expect(saved?.view).toBe('inbox')
    expect(saved?.splitId).toBe('important')
    expect(new Map(saved?.viewRecords ?? []).get('inbox')).toEqual({
      rowId: 'thread-9',
      index: 7,
      scrollTop: 42,
      loadedRows: 25
    })
    expect(new Map(saved?.splitRecords ?? []).get('important')?.rowId).toBe('thread-9')
  } finally {
    await harness.unmount()
  }
})

test('an outbox snapshot records the view it covered', async () => {
  const harness = await mount()
  try {
    harness.view.current = 'outbox'
    harness.store.outboxReturn.current = { view: 'allMail', selectedIndex: 2, readerOpen: false }
    harness.store.saveAccountSnapshot()
    expect(readAccountView(ACCOUNT)?.view).toBe('allMail')
  } finally {
    await harness.unmount()
  }
})

test('a restored snapshot primes the split restore for a split inbox', async () => {
  const harness = await mount({
    view: 'inbox',
    splitId: 'other',
    viewRecords: [['inbox', { rowId: 'thread-2', index: 1, scrollTop: 10 }]],
    splitRecords: [['other', { rowId: 'thread-3', index: 4, scrollTop: 80 }]]
  })
  try {
    expect(harness.store.pendingSplitRestore.current).toEqual({
      id: 'other',
      record: { rowId: 'thread-3', index: 4, scrollTop: 80 }
    })
    expect(harness.store.pendingViewRestore.current).toBeNull()
    expect(harness.store.viewRecords.current.get('inbox')?.rowId).toBe('thread-2')
  } finally {
    await harness.unmount()
  }
})

test('a restored snapshot for a non-inbox view primes the view restore instead', async () => {
  const harness = await mount({
    view: 'starred',
    splitId: 'other',
    viewRecords: [['starred', { rowId: 'thread-5', index: 2, scrollTop: 30 }]],
    splitRecords: []
  })
  try {
    expect(harness.store.pendingSplitRestore.current).toBeNull()
    expect(harness.store.pendingViewRestore.current).toEqual({
      view: 'starred',
      record: { rowId: 'thread-5', index: 2, scrollTop: 30 }
    })
  } finally {
    await harness.unmount()
  }
})
