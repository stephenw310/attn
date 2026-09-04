// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { TriageAction } from '../../../shared/actions'
import type { DisplayThread } from '../list/mailDisplay'
import { useListActions } from './useListActions'
import type { ViewRecordStore } from './useViewRecords'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function thread(id: string, overrides: Partial<DisplayThread> = {}): DisplayThread {
  return {
    id,
    from: 'Sender',
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
    labelIds: ['INBOX'],
    lastMsgAt: 1,
    ...overrides
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

async function mount(overrides: Record<string, unknown> = {}) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const snooze = vi.fn(async () => ({ label: 'Snoozed' }))
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { snooze } } as unknown as Window['attn']
  })
  const triaged: TriageAction[] = []
  const store = records()
  const state = {
    threads: [thread('thread-1'), thread('thread-2'), thread('thread-3')],
    selectedIndex: 1,
    selectedIds: new Set<string>(),
    readerOpen: false,
    opened: [] as string[],
    moveRequest: null as unknown,
    snoozeOpen: false,
    labelTargetIds: null as readonly string[] | null
  }
  const root = createRoot(document.createElement('div'))
  const results: ReturnType<typeof useListActions>[] = []
  function Harness(): null {
    results.push(
      useListActions({
        view: 'inbox',
        searchOpen: false,
        searchDraftMode: false,
        searchDrafts: [],
        threads: state.threads,
        realDrafts: [],
        realOutbox: [],
        selectedIndex: state.selectedIndex,
        selected: state.threads[state.selectedIndex],
        selectedIds: state.selectedIds,
        targetedThreads:
          state.selectedIds.size > 0
            ? state.threads.filter((row) => state.selectedIds.has(row.id))
            : [state.threads[state.selectedIndex]],
        detachedDraftThread: null,
        readerOpen: state.readerOpen,
        moveAllowed: true,
        autoAdvance: 'next',
        labelTargets: undefined,
        moveRequest: state.moveRequest as never,
        triage: (action) => triaged.push(action),
        records: store,
        inlineComposerRef: createRef(),
        listElRef: createRef<HTMLElement>(),
        selectedThreadIdRef: { current: null },
        setSelectedIndex: (index) => {
          state.selectedIndex = index
        },
        setReaderOpen: (open) => {
          state.readerOpen = open
        },
        setSnoozeOpen: (open) => {
          state.snoozeOpen = open
        },
        setLabelTargetIds: (ids) => {
          state.labelTargetIds = ids
        },
        setMoveRequest: (request) => {
          state.moveRequest = request
        },
        setDetachedDraftThread: () => {},
        finishReaderClose: () => {
          state.readerOpen = false
        },
        clearSelection: () => state.selectedIds.clear(),
        reopenDraftForThread: (id) => state.opened.push(id),
        reopenListDraft: () => {},
        openOutboxItem: () => {},
        focusSearchResults: () => {},
        showToast: async () => {},
        ...overrides
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
    triaged,
    snooze,
    render,
    actions: () => results.at(-1) as ReturnType<typeof useListActions>,
    first: () => results[0] as ReturnType<typeof useListActions>,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('keeps one identity for every action while the cursor and the list move', async () => {
  const harness = await mount()
  try {
    const first = harness.first()
    harness.state.selectedIndex = 2
    harness.state.threads = [thread('thread-1'), thread('thread-2'), thread('thread-3')]
    await harness.render()
    const later = harness.actions()
    for (const key of Object.keys(first) as Array<keyof typeof first>) {
      expect(later[key], key).toBe(first[key])
    }

    // The stale closure still acts on the row that is focused now.
    await act(async () => first.openSelected())
    expect(harness.state.opened).toEqual(['thread-3'])
  } finally {
    await harness.unmount()
  }
})

test('opening a row records where the list was, so returning restores it', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.actions().openThread(2))
    expect(harness.store.viewRecords.current.get('inbox')).toEqual({
      rowId: 'thread-3',
      index: 2,
      scrollTop: 0
    })
    expect(harness.state.readerOpen).toBe(true)
    expect(harness.state.opened).toEqual(['thread-3'])
  } finally {
    await harness.unmount()
  }
})

test('the triage verbs act on the whole selection when there is one', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.actions().markNotDone())
    expect(harness.triaged.at(-1)).toMatchObject({ kind: 'move', threadIds: ['thread-2'] })

    harness.state.selectedIds = new Set(['thread-1', 'thread-3'])
    await harness.render()
    await act(async () => harness.actions().markNotDone())
    expect(harness.triaged.at(-1)).toMatchObject({ threadIds: ['thread-1', 'thread-3'] })

    await act(async () => harness.actions().openLabel())
    expect(harness.state.labelTargetIds).toEqual(['thread-1', 'thread-3'])

    await act(async () => harness.actions().openMove())
    expect(harness.state.moveRequest).toMatchObject({
      targets: [{ id: 'thread-1' }, { id: 'thread-3' }],
      sourceLabelId: null
    })
  } finally {
    await harness.unmount()
  }
})

test('J and K walk the list and stop at both ends', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.actions().navigateNext())
    expect(harness.state.selectedIndex).toBe(2)
    await harness.render()
    await act(async () => harness.actions().navigateNext())
    expect(harness.state.selectedIndex).toBe(2)

    harness.state.selectedIndex = 0
    await harness.render()
    await act(async () => harness.actions().navigatePrevious())
    expect(harness.state.selectedIndex).toBe(0)
  } finally {
    await harness.unmount()
  }
})

test('snoozing the selection closes the picker and asks main once', async () => {
  const harness = await mount()
  try {
    harness.state.selectedIds = new Set(['thread-1', 'thread-2'])
    await harness.render()
    await act(async () => harness.actions().snoozeSelected(1_700_000_000_000))
    expect(harness.state.snoozeOpen).toBe(false)
    expect(harness.snooze).toHaveBeenCalledWith(['thread-1', 'thread-2'], 1_700_000_000_000)
  } finally {
    await harness.unmount()
  }
})
