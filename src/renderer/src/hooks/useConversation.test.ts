// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { Conversation, ConversationMailbox } from '../../../shared/mail'
import type { DisplayThread } from '../list/mailDisplay'
import { useConversation } from './useConversation'

const thread: DisplayThread = {
  id: 'mixed-thread',
  from: 'Sender',
  subject: 'Mixed thread',
  snippet: '',
  at: '9:30 AM',
  unread: false,
  starred: false,
  hasAttachment: false,
  snoozed: false,
  returned: false,
  followUpReturned: false,
  hasDraft: false,
  labelIds: [],
  lastMsgAt: 1
}

function conversation(subject: string): Conversation {
  return { threadId: thread.id, subject, messages: [] }
}

test('caches each mailbox projection of a conversation independently', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  const getConversation = vi.fn((_threadId: string, _hydrate: boolean, mailbox: ConversationMailbox) =>
    Promise.resolve(
      mailbox === 'trash' ? conversation('Trash projection') : conversation('Normal projection')
    )
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        getConversation,
        markReadOnOpen: () => Promise.resolve(),
        onBodyHydrationFailed: () => () => {}
      }
    } as unknown as Window['attn']
  })
  const container = document.createElement('div')
  const root = createRoot(container)

  function Harness({ mailbox }: { mailbox: ConversationMailbox }): React.JSX.Element {
    const { conversation: current } = useConversation({
      selected: thread,
      selectedIndex: 0,
      threads: [thread],
      readerOpen: true,
      prefetch: false,
      online: true,
      account: 'search@example.test',
      mailRevision: 0,
      mailbox
    })
    return createElement('span', null, current?.subject ?? 'loading')
  }

  try {
    await act(async () => root.render(createElement(Harness, { mailbox: 'normal' })))
    expect(container.textContent).toBe('Normal projection')

    await act(async () => root.render(createElement(Harness, { mailbox: 'trash' })))
    expect(container.textContent).toBe('Trash projection')
    expect(getConversation.mock.calls.map((call) => call[2])).toEqual(['normal', 'trash'])

    await act(async () => root.render(createElement(Harness, { mailbox: 'normal' })))
    expect(container.textContent).toBe('Normal projection')
    expect(getConversation).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})
