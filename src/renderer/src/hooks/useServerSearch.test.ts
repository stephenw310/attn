// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { ServerSearchResponse } from '../../../shared/searchQuery'
import { useServerSearch } from './useServerSearch'

test('coalesces repeated invocations while a Gmail search is pending', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  let resolveSearch: ((response: ServerSearchResponse) => void) | undefined
  const searchAll = vi.fn(
    (_requestId: string, _query: string) =>
      new Promise<ServerSearchResponse>((resolve) => {
        resolveSearch = resolve
      })
  )
  const cancelSearchAll = vi.fn(async () => undefined)
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { searchAll, cancelSearchAll } } as unknown as Window['attn']
  })
  const container = document.createElement('div')
  const root = createRoot(container)

  function Harness(): React.JSX.Element {
    const search = useServerSearch(true, 'remote', 'search@example.test', 0, true)
    return createElement('button', { type: 'button', onClick: search.run }, search.phase)
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    const button = container.querySelector('button')
    act(() => {
      button?.click()
      button?.click()
    })
    expect(searchAll).toHaveBeenCalledOnce()
    expect(searchAll).toHaveBeenCalledWith(expect.any(String), 'remote')

    await act(async () => resolveSearch?.({ status: 'ok', rows: [], quotaWaitMs: 0 }))
    expect(button?.textContent).toBe('complete')
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})

test('cancels a pending Gmail search when the query is superseded', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  const searches: Array<(response: ServerSearchResponse) => void> = []
  const searchAll = vi.fn(
    (_requestId: string, _query: string) =>
      new Promise<ServerSearchResponse>((resolve) => {
        searches.push(resolve)
      })
  )
  const cancelSearchAll = vi.fn(async () => undefined)
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { mail: { searchAll, cancelSearchAll } } as unknown as Window['attn']
  })
  const container = document.createElement('div')
  const root = createRoot(container)

  function Harness({ query }: { query: string }): React.JSX.Element {
    const search = useServerSearch(true, query, 'search@example.test', 0, true)
    return createElement('button', { type: 'button', onClick: search.run }, search.phase)
  }

  try {
    await act(async () => root.render(createElement(Harness, { query: 'first' })))
    act(() => container.querySelector('button')?.click())
    const firstRequestId = searchAll.mock.calls[0]?.[0]

    await act(async () => root.render(createElement(Harness, { query: 'second' })))
    expect(cancelSearchAll).toHaveBeenCalledWith(firstRequestId)
    expect(container.querySelector('button')?.textContent).toBe('idle')

    act(() => container.querySelector('button')?.click())
    expect(searchAll).toHaveBeenCalledTimes(2)
    expect(searchAll).toHaveBeenLastCalledWith(expect.any(String), 'second')

    await act(async () => searches[1]?.({ status: 'ok', rows: [], quotaWaitMs: 0 }))
    expect(container.querySelector('button')?.textContent).toBe('complete')
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})
