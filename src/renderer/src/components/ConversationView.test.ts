// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { DisplayConversation, DisplayThread } from '../mailDisplay'
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
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(createElement(ConversationView, props)))
    const readsAfterFirstRender = subjectReads
    expect(readsAfterFirstRender).toBeGreaterThan(0)

    await act(async () => root.render(createElement(ConversationView, props)))
    expect(subjectReads).toBe(readsAfterFirstRender)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('opens a message appended to the current conversation by default', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
    ResizeObserver: typeof ResizeObserver
  }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  const previousResizeObserver = actEnvironment.ResizeObserver
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  actEnvironment.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  const selected: DisplayThread = {
    id: 'thread-1',
    from: 'Maya',
    subject: 'Roadmap',
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
  const message = (id: string, text: string) => ({
    id,
    pending: id.startsWith('outbox:'),
    trashed: false,
    fromName: id.startsWith('outbox:') ? 'me@example.com' : 'Maya',
    fromEmail: id.startsWith('outbox:') ? 'me@example.com' : 'maya@example.com',
    at: '9:30 AM',
    fullDate: 'Friday, August 21, 2026 at 9:30 AM PDT',
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    attachments: [],
    text,
    html: null,
    bodyState: 'complete' as const
  })
  const initial: DisplayConversation = {
    threadId: 'thread-1',
    subject: 'Roadmap',
    messages: [message('message-1', 'First'), message('message-2', 'Second')],
    bodyHydrationFailed: false
  }
  const scrollRef = { current: null as HTMLDivElement | null }
  const props = {
    selected,
    selectedIndex: 0,
    threadCount: 1,
    view: 'inbox' as const,
    account: 'me@example.com',
    online: true,
    scrollRef,
    inlineComposer: null,
    inlineComposerDraftId: null,
    onClose: (): void => {},
    onToast: (): void => {}
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(createElement(ConversationView, { ...props, conversation: initial })))
    const initialCards = container.querySelectorAll('[data-testid="message-card"]')
    expect(initialCards[0]?.getAttribute('data-collapsed')).toBe('true')
    expect(initialCards[1]?.getAttribute('data-collapsed')).toBe('false')

    const collapseToggle = initialCards[1]?.querySelector('[data-testid="older-message-toggle"]')
    if (!(collapseToggle instanceof HTMLButtonElement)) throw new Error('missing newest-message toggle')
    await act(async () => collapseToggle.click())
    await act(async () =>
      root.render(
        createElement(ConversationView, {
          ...props,
          conversation: { ...initial, messages: [...initial.messages] }
        })
      )
    )
    expect(
      container.querySelectorAll('[data-testid="message-card"]')[1]?.getAttribute('data-collapsed')
    ).toBe('true')

    const appended = {
      ...initial,
      messages: [...initial.messages, message('outbox:reply-1', 'Queued reply')]
    }
    await act(async () => root.render(createElement(ConversationView, { ...props, conversation: appended })))
    const appendedCards = container.querySelectorAll('[data-testid="message-card"]')
    expect(appendedCards).toHaveLength(3)
    expect(appendedCards[2]?.getAttribute('data-pending')).toBe('true')
    expect(appendedCards[2]?.getAttribute('data-collapsed')).toBe('false')
    expect(document.activeElement?.getAttribute('data-testid')).toBe('conversation-scroll')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    actEnvironment.ResizeObserver = previousResizeObserver
  }
})
