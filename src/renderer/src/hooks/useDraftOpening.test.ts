// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { Draft } from '../../../shared/drafts'
import type { MailView } from '../mailDisplay'
import { useDraftOpening } from './useDraftOpening'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function draft(id: string, overrides: Partial<Draft> = {}): Draft {
  return {
    id,
    kind: 'reply',
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    subject: 'Re: Alpha',
    to: [],
    cc: [],
    bcc: [],
    bodyHtml: '',
    updatedAt: 1,
    ...overrides
  } as Draft
}

async function mount(bridge: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const draftBridge = {
    takeRecovered: vi.fn(async () => null),
    reopen: vi.fn(async (id: string) => draft(id)),
    close: vi.fn(async () => {}),
    get: vi.fn(async (id: string) => draft(id)),
    save: vi.fn(async () => ({ draft: draft('new-1', { kind: 'new', threadId: null }) })),
    createReply: vi.fn(async () => draft('reply-1')),
    discard: vi.fn(async () => {}),
    ...bridge
  }
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { draft: draftBridge, outbox: { undoSend: vi.fn(), reopen: vi.fn() } } as unknown as Window['attn']
  })
  const state = {
    composerDraft: null as Draft | null,
    composerError: null as string | null,
    readerOpen: true,
    view: 'inbox' as MailView,
    toasts: [] as string[],
    detached: [] as unknown[],
    applied: [] as MailView[]
  }
  const accountSwitchPendingRef = { current: false }
  const composerOpeningRef = { current: false }
  const draftOpenRequestRef = { current: 0 }
  const draftOpenTargetRef = {
    current: null as { request: number; draftId: string; threadId: string } | null
  }
  const selectedThreadIdRef = { current: 'thread-1' as string | null }
  const selected = { id: 'thread-1' } as never
  const root = createRoot(document.createElement('div'))
  const results: ReturnType<typeof useDraftOpening>[] = []
  function Harness(): null {
    results.push(
      useDraftOpening({
        account: 'a@attn.test',
        view: state.view,
        viewRef: { current: state.view },
        searchOpen: false,
        searchOpenRef: { current: false },
        searchResultQuery: '',
        readerOpen: state.readerOpen,
        readerOpenRef: { current: state.readerOpen },
        selected,
        selectedRef: { current: selected },
        conversation: null,
        messageReplyTargetRef: { current: null },
        composerDraft: state.composerDraft,
        setComposerDraft: (next) => {
          state.composerDraft = next
        },
        composerError: state.composerError,
        setComposerError: (message) => {
          state.composerError = message
        },
        setDetachedDraftThread: (next) => state.detached.push(next),
        realThreads: [],
        realSnoozedThreads: [],
        realDrafts: [draft('draft-1')],
        realOutbox: [],
        selectedIndex: 0,
        accountSwitchPendingRef,
        composerOpeningRef,
        draftOpenRequestRef,
        draftOpenTargetRef,
        inlineComposerRef: createRef(),
        selectedThreadIdRef,
        selectedDraftIdRef: { current: null },
        settingsOpenRef: { current: false },
        applyView: (next) => state.applied.push(next),
        clearSelection: () => {},
        setSelectedIndex: () => {},
        setReaderOpen: (open) => {
          state.readerOpen = open
        },
        closePickers: () => {},
        finishReaderClose: () => {},
        invalidateConversations: () => {},
        refreshMailRows: async () => {},
        refreshDrafts: async () => {},
        showToast: async (message) => {
          state.toasts.push(message)
        },
        ...options
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
    draftBridge,
    accountSwitchPendingRef,
    draftOpenRequestRef,
    draftOpenTargetRef,
    selectedThreadIdRef,
    render,
    api: () => results.at(-1) as ReturnType<typeof useDraftOpening>,
    first: () => results[0] as ReturnType<typeof useDraftOpening>,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('a settling account switch makes every route into a composer inert', async () => {
  const harness = await mount()
  try {
    harness.accountSwitchPendingRef.current = true
    await act(async () => {
      harness.api().openComposer()
      harness.api().reopenListDraft('draft-1')
      harness.api().reopenUndoDraft('draft-1')
      harness.api().reopenDraftForThread('thread-1')
      harness.api().openReply('reply')
    })
    expect(harness.draftBridge.save).not.toHaveBeenCalled()
    expect(harness.draftBridge.reopen).not.toHaveBeenCalled()
    expect(harness.draftBridge.get).not.toHaveBeenCalled()
    expect(harness.draftBridge.createReply).not.toHaveBeenCalled()
    expect(harness.state.composerDraft).toBeNull()
  } finally {
    await harness.unmount()
  }
})

test('a reopen the reader superseded releases the lease it was handed', async () => {
  const harness = await mount()
  try {
    await act(async () => {
      harness.api().reopenDraftForThread('thread-1')
      // The reader closes before the round trip lands, bumping the counter.
      harness.draftOpenRequestRef.current += 1
      harness.draftOpenTargetRef.current = null
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.draftBridge.close).toHaveBeenCalledWith('draft-1')
    expect(harness.state.composerDraft).toBeNull()
  } finally {
    await harness.unmount()
  }
})

test('a reopen that still owns the reader mounts its composer', async () => {
  const harness = await mount()
  try {
    await act(async () => {
      harness.api().reopenDraftForThread('thread-1')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.state.composerDraft?.id).toBe('draft-1')
    expect(harness.draftBridge.close).not.toHaveBeenCalled()
    expect(harness.draftOpenTargetRef.current).toBeNull()
  } finally {
    await harness.unmount()
  }
})

test('a reply that never opens says so and parks no AI invocation', async () => {
  const harness = await mount({ createReply: vi.fn(async () => null) })
  try {
    await act(async () => {
      harness.api().openReply('reply')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.state.toasts.at(-1)).toContain('Could not open this message for a reply or forward')
    expect(harness.state.composerDraft).toBeNull()
  } finally {
    await harness.unmount()
  }
})

test('an inline reply belongs to its conversation; anything else covers the window', async () => {
  const harness = await mount()
  try {
    harness.state.composerDraft = draft('draft-1')
    await harness.render()
    expect(harness.api().inlineComposerDraft?.id).toBe('draft-1')
    expect(harness.api().fullWindowComposerDraft).toBeNull()

    // A reply to another conversation, or a new message, is full-window.
    harness.state.composerDraft = draft('draft-2', { threadId: 'thread-other' })
    await harness.render()
    expect(harness.api().inlineComposerDraft).toBeNull()
    expect(harness.api().fullWindowComposerDraft?.id).toBe('draft-2')

    harness.state.composerDraft = draft('draft-3', { kind: 'new', threadId: null })
    await harness.render()
    expect(harness.api().fullWindowComposerDraft?.id).toBe('draft-3')
  } finally {
    await harness.unmount()
  }
})

test('keeps one identity for every route while the draft and the list move', async () => {
  const harness = await mount()
  try {
    const first = harness.first()
    harness.state.composerDraft = draft('draft-1')
    await harness.render()
    const later = harness.api()
    for (const key of [
      'showDraft',
      'reopenDraftForThread',
      'reopenListDraft',
      'openComposer',
      'openReply',
      'closeComposer',
      'discardSelectedDraft',
      'requestAiDraftCommand'
    ] as const) {
      expect(later[key], key).toBe(first[key])
    }
  } finally {
    await harness.unmount()
  }
})
