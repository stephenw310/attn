// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { SearchResponse } from '../../../shared/searchQuery'
import { SEARCH_DEBOUNCE_MS } from '../tuning'
import { useLocalSearch } from './useLocalSearch'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  vi.useRealTimers()
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function response(query: string): SearchResponse {
  return {
    rows: [
      {
        id: `thread-${query}`,
        fromDisplay: 'Sender',
        subject: query,
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
    ],
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

test('an older response never replaces a newer query, and a stale mail revision is dropped', async () => {
  vi.useFakeTimers()
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const pending: Array<{ query: string; resolve: (value: SearchResponse) => void }> = []
  const search = vi.fn(
    (query: string) =>
      new Promise<SearchResponse>((resolve) => {
        pending.push({ query, resolve })
      })
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { search } } as unknown as Window['attn']
  })

  const root = createRoot(document.createElement('div'))
  const states: ReturnType<typeof useLocalSearch>[] = []
  let props = { open: true, query: 'alpha', account: 'a@attn.test', mailRevision: 1 }
  function Harness(): null {
    states.push(useLocalSearch(props.open, props.query, props.account, props.mailRevision))
    return null
  }
  const render = async (next: Partial<typeof props>): Promise<void> => {
    props = { ...props, ...next }
    await act(async () => root.render(createElement(Harness)))
  }

  try {
    await render({})
    // The read is debounced: nothing has been asked for yet.
    expect(search).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(search).toHaveBeenCalledWith('alpha')
    expect(states.at(-1)?.pending).toBe(true)

    // Retyping supersedes the first read before it lands.
    await render({ query: 'beta' })
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    expect(search).toHaveBeenCalledWith('beta')

    await act(async () => {
      pending[0]?.resolve(response('alpha'))
      await Promise.resolve()
    })
    expect(states.at(-1)?.completedQuery).toBeNull()
    expect(states.at(-1)?.response).toBeNull()

    await act(async () => {
      pending[1]?.resolve(response('beta'))
      await Promise.resolve()
    })
    expect(states.at(-1)?.completedQuery).toBe('beta')
    expect(states.at(-1)?.pending).toBe(false)

    // A mail change between request and response invalidates the answer: the
    // rows it describes are already stale, and a fresh read is on its way.
    await render({ query: 'gamma' })
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    })
    await render({ mailRevision: 2 })
    await act(async () => {
      pending[2]?.resolve(response('gamma'))
      await Promise.resolve()
    })
    expect(states.at(-1)?.completedQuery).toBe('beta')
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
