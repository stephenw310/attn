// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THREAD_PAGE_SIZE,
  type ThreadPage,
  type ThreadPageCursor,
  type ThreadRow
} from '../../../shared/mail'
import type { MailView } from '../mailDisplay'
import { useMailData } from './useMailData'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function thread(id: string): ThreadRow {
  return {
    id,
    fromDisplay: 'Sender',
    subject: id,
    snippet: '',
    lastMsgAt: 1,
    unread: false,
    starred: false,
    hasAttachment: false,
    returned: false,
    hasDraft: false,
    labelIds: []
  }
}

const mountedRoots: ReturnType<typeof createRoot>[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount())
  vi.restoreAllMocks()
})

describe('useMailData mailbox refreshes', () => {
  it('does not let an older Inbox snapshot erase rows loaded after switching mailboxes', async () => {
    const initialInbox = deferred<ThreadPage>()
    const allMailRows = [thread('all-mail-row')]
    const listThreadPage = vi.fn((view: string) =>
      view === 'inbox' ? initialInbox.promise : Promise.resolve({ rows: allMailRows, nextCursor: null })
    )
    const stop = (): void => {}
    const bridge = {
      sync: {
        getState: () => Promise.resolve({ phase: 'idle' as const }),
        retry: () => Promise.resolve(),
        onState: () => stop
      },
      mail: {
        listThreadPage,
        listLabelThreadPage: () => Promise.resolve({ rows: [], nextCursor: null }),
        listSnoozedPage: () => Promise.resolve({ rows: [], nextCursor: null }),
        listLabels: () => Promise.resolve([]),
        getMailboxCounts: () =>
          Promise.resolve({ inbox: 0, allMail: 0, sent: 0, starred: 0, snoozed: 0, spam: 0, trash: 0 }),
        getUnreadCount: () => Promise.resolve(0),
        getPendingActionCount: () => Promise.resolve(0),
        getActionQueueStatus: () => Promise.resolve({ pending: 0, paused: 0 }),
        onChanged: () => stop
      },
      draft: { list: () => Promise.resolve([]) },
      outbox: {
        listPending: () => Promise.resolve([]),
        onChanged: () => stop,
        onProgress: () => stop
      }
    } as unknown as typeof window.attn
    Object.defineProperty(window, 'attn', { configurable: true, value: bridge })

    const activeViewRef: React.RefObject<MailView> = { current: 'inbox' }
    const selectedThreadIdRef: React.RefObject<string | null> = { current: null }
    const selectedDraftIdRef: React.RefObject<string | null> = { current: null }
    let latest: ReturnType<typeof useMailData> | null = null
    const setSelectedIndex = vi.fn()

    const currentState = (): ReturnType<typeof useMailData> => {
      if (!latest) throw new Error('hook state was not captured')
      return latest
    }

    function Harness(): null {
      latest = useMailData(
        'seed@attn.test',
        activeViewRef,
        selectedThreadIdRef,
        selectedDraftIdRef,
        setSelectedIndex
      )
      return null
    }

    const host = document.createElement('div')
    const root = createRoot(host)
    mountedRoots.push(root)
    await act(async () => {
      root.render(createElement(Harness))
      await Promise.resolve()
    })
    expect(listThreadPage).toHaveBeenCalledWith('inbox', undefined)

    activeViewRef.current = 'allMail'
    await act(async () => {
      await currentState().refreshCachedThreadView('allMail')
    })
    expect(currentState().mailboxRows.allMail).toEqual(allMailRows)

    await act(async () => {
      initialInbox.resolve({ rows: [], nextCursor: null })
      await initialInbox.promise
      await Promise.resolve()
    })
    expect(currentState().mailboxRows.allMail).toEqual(allMailRows)
  })

  it('pages to a notification target and keeps the Inbox cursor in sync with the rows', async () => {
    const firstRows = Array.from({ length: THREAD_PAGE_SIZE }, (_, index) => thread(`page-1-${index}`))
    const target = thread('notification-target')
    const firstPageCursor: ThreadPageCursor = { at: 100, id: 'page-1-99' }
    const listThreadPage = vi.fn((view: string, cursor?: ThreadPageCursor) => {
      if (view !== 'inbox') return Promise.resolve({ rows: [], nextCursor: null })
      return Promise.resolve(
        cursor ? { rows: [target], nextCursor: null } : { rows: firstRows, nextCursor: firstPageCursor }
      )
    })
    const stop = (): void => {}
    const bridge = {
      sync: {
        getState: () => Promise.resolve({ phase: 'idle' as const }),
        retry: () => Promise.resolve(),
        onState: () => stop
      },
      mail: {
        listThreadPage,
        listLabelThreadPage: () => Promise.resolve({ rows: [], nextCursor: null }),
        listSnoozedPage: () => Promise.resolve({ rows: [], nextCursor: null }),
        listLabels: () => Promise.resolve([]),
        getMailboxCounts: () =>
          Promise.resolve({
            inbox: 101,
            allMail: 101,
            sent: 0,
            starred: 0,
            snoozed: 0,
            spam: 0,
            trash: 0
          }),
        getUnreadCount: () => Promise.resolve(0),
        getPendingActionCount: () => Promise.resolve(0),
        getActionQueueStatus: () => Promise.resolve({ pending: 0, paused: 0 }),
        onChanged: () => stop
      },
      draft: { list: () => Promise.resolve([]) },
      outbox: {
        listPending: () => Promise.resolve([]),
        onChanged: () => stop,
        onProgress: () => stop
      }
    } as unknown as typeof window.attn
    Object.defineProperty(window, 'attn', { configurable: true, value: bridge })

    const activeViewRef: React.RefObject<MailView> = { current: 'inbox' }
    const selectedThreadIdRef: React.RefObject<string | null> = { current: null }
    const selectedDraftIdRef: React.RefObject<string | null> = { current: null }
    let latest: ReturnType<typeof useMailData> | null = null
    const setSelectedIndex = vi.fn()

    const currentState = (): ReturnType<typeof useMailData> => {
      if (!latest) throw new Error('hook state was not captured')
      return latest
    }

    function Harness(): null {
      latest = useMailData(
        'seed@attn.test',
        activeViewRef,
        selectedThreadIdRef,
        selectedDraftIdRef,
        setSelectedIndex
      )
      return null
    }

    const host = document.createElement('div')
    const root = createRoot(host)
    mountedRoots.push(root)
    await act(async () => {
      root.render(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })

    let targetIndex: number | null = null
    await act(async () => {
      targetIndex = await currentState().focusInboxThread(target.id)
    })

    expect(targetIndex).toBe(THREAD_PAGE_SIZE)
    expect(listThreadPage).toHaveBeenCalledWith('inbox', firstPageCursor)
    expect(currentState().realThreads).toHaveLength(THREAD_PAGE_SIZE + 1)
    expect(currentState().realThreads?.at(-1)?.id).toBe(target.id)
    expect(currentState().threadPagination.inbox).toEqual({
      nextCursor: null,
      loadingMore: false
    })
  })
})
