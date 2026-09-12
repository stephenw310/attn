// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DisplayConversation, DisplayThread } from '../list/mailDisplay'
import { ConversationView, type MessageReplyTarget } from './ConversationView'

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
    snoozed: false,
    returned: false,
    followUpReturned: false,
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
    threadCount: 100,
    threadCountExact: false,
    view: 'inbox' as const,
    mailboxTitle: 'Inbox',
    labels: [],
    onOpenLabel: () => {},
    conversation: null,
    account: 'seed@attn.test',
    online: true,
    scrollRef,
    replyTargetRef: { current: null as MessageReplyTarget | null },
    inlineComposer: null,
    inlineComposerDraftId: null,
    inlineComposerSourceMessageId: null,
    onClose,
    onToast,
    onReply: (): void => {}
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => root.render(createElement(ConversationView, props)))
    const readsAfterFirstRender = subjectReads
    expect(readsAfterFirstRender).toBeGreaterThan(0)
    expect(container.querySelector('[data-testid="conversation-position"]')).toBeNull()

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
    snoozed: false,
    returned: false,
    followUpReturned: false,
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
    threadCountExact: true,
    view: 'inbox' as const,
    mailboxTitle: 'Inbox',
    labels: [],
    onOpenLabel: () => {},
    account: 'me@example.com',
    online: true,
    scrollRef,
    replyTargetRef: { current: null as MessageReplyTarget | null },
    inlineComposer: null,
    inlineComposerDraftId: null,
    inlineComposerSourceMessageId: null,
    onClose: (): void => {},
    onToast: (): void => {},
    onReply: (): void => {}
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

    await act(async () => {
      container
        .querySelector('[data-testid="conversation-message"]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    const received = {
      ...initial,
      messages: [...initial.messages, message('message-3', 'New incoming mail')]
    }
    await act(async () => root.render(createElement(ConversationView, { ...props, conversation: received })))
    expect(container.querySelector('[data-active-message="true"]')?.getAttribute('data-message-id')).toBe(
      'message-1'
    )
    expect(props.replyTargetRef.current).toEqual({
      threadId: 'thread-1',
      messageId: 'message-1',
      expand: expect.any(Function),
      canReply: true
    })

    const appended = {
      ...initial,
      messages: [...received.messages, message('outbox:reply-1', 'Queued reply')]
    }
    await act(async () => root.render(createElement(ConversationView, { ...props, conversation: appended })))
    const appendedCards = container.querySelectorAll('[data-testid="message-card"]')
    expect(appendedCards).toHaveLength(4)
    expect(appendedCards[3]?.getAttribute('data-pending')).toBe('true')
    expect(appendedCards[3]?.getAttribute('data-collapsed')).toBe('false')
    expect(props.replyTargetRef.current?.canReply).toBe(false)
    expect(document.activeElement?.getAttribute('data-testid')).toBe('conversation-scroll')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    actEnvironment.ResizeObserver = previousResizeObserver
  }
})

it('keeps unsaved composer state when its source loads, disappears, or moves in the conversation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  const selected: DisplayThread = {
    id: 'thread-1',
    from: 'Jordan',
    subject: 'Account question',
    snippet: '',
    at: '',
    unread: false,
    starred: false,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    followUpReturned: false,
    hasDraft: true,
    labelIds: [],
    lastMsgAt: 0
  }
  const message = (id: string): DisplayConversation['messages'][number] => ({
    id,
    pending: false,
    trashed: false,
    fromName: 'Jordan',
    fromEmail: 'jordan@example.com',
    at: '',
    fullDate: '',
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    attachments: [],
    text: id,
    html: null,
    bodyState: 'complete'
  })
  const props = {
    selected,
    selectedIndex: 0,
    threadCount: 1,
    threadCountExact: true,
    mailboxTitle: 'Inbox',
    labels: [],
    onOpenLabel: () => {},
    account: 'me@example.com',
    online: true,
    scrollRef: { current: null as HTMLDivElement | null },
    replyTargetRef: { current: null as MessageReplyTarget | null },
    inlineComposer: createElement('textarea', { 'data-testid': 'draft-input', defaultValue: '' }),
    inlineComposerDraftId: 'draft-1',
    inlineComposerSourceMessageId: 'source',
    onClose: (): void => {},
    onToast: (): void => {},
    onReply: (): void => {}
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ConversationView, { ...props, conversation: null })))
    const input = container.querySelector('textarea')
    if (!input) throw new Error('missing composer')
    input.value = 'An unsaved reply'
    for (const ids of [['source', 'later'], ['later'], ['earlier', 'source', 'later']]) {
      const conversation: DisplayConversation = {
        threadId: selected.id,
        subject: selected.subject,
        messages: ids.map(message),
        bodyHydrationFailed: false
      }
      await act(async () => root.render(createElement(ConversationView, { ...props, conversation })))
      expect(container.querySelector('textarea')).toBe(input)
      expect(input.value).toBe('An unsaved reply')
      const beforeComposer = input.parentElement?.previousElementSibling
      expect(beforeComposer?.getAttribute('data-message-id')).toBe(
        ids.includes('source') ? 'source' : 'later'
      )
      if (ids.includes('source')) {
        expect(container.querySelector('[data-active-message="true"]')?.getAttribute('data-message-id')).toBe(
          'source'
        )
        expect(
          beforeComposer?.querySelector('[data-testid="message-card"]')?.getAttribute('data-collapsed')
        ).toBe('false')
      }
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
