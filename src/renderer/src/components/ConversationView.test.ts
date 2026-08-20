// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { DisplayThread } from '../mailDisplay'
import { ConversationView } from './ConversationView'

it('skips the reader tree when only footer sync progress changes above it', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let subjectReads = 0
  const selected: DisplayThread = {
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
  const scrollRef = { current: null as HTMLDivElement | null }
  const onClose = (): void => {}
  const onToast = (): void => {}
  const props = {
    selected,
    selectedIndex: 0,
    threadCount: 1,
    view: 'inbox' as const,
    conversation: null,
    account: 'seed@attn.test',
    online: true,
    scrollRef,
    inlineComposer: null,
    inlineComposerDraftId: null,
    onClose,
    onToast
  }
  const container = document.createElement('div')
  const root = createRoot(container)

  try {
    await act(async () => root.render(createElement(ConversationView, props)))
    const readsAfterFirstRender = subjectReads
    expect(readsAfterFirstRender).toBeGreaterThan(0)

    await act(async () => root.render(createElement(ConversationView, props)))
    expect(subjectReads).toBe(readsAfterFirstRender)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
