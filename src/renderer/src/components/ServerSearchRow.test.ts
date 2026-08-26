// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ServerSearchRow } from './ServerSearchRow'

let previousActEnvironment: boolean | undefined

beforeEach(() => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

it('disables the Gmail row offline and names the reason', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(ServerSearchRow, {
          phase: 'idle',
          resultCount: 0,
          message: null,
          quotaWaitMs: 0,
          online: false,
          onSearch: vi.fn(),
          onReconnect: vi.fn(),
          onFocusQuery: vi.fn()
        })
      )
    )
    const button = container.querySelector('button')
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toContain('back online')
  } finally {
    await act(async () => root.unmount())
  }
})

it('routes an auth pause to reconnect and reports a quota-delayed completion', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const reconnect = vi.fn()
  const base = {
    resultCount: 0,
    message: 'Google authorization expired',
    quotaWaitMs: 0,
    online: true,
    onSearch: vi.fn(),
    onReconnect: reconnect,
    onFocusQuery: vi.fn()
  }
  try {
    await act(async () => root.render(createElement(ServerSearchRow, { ...base, phase: 'auth-required' })))
    const button = container.querySelector('button')
    button?.click()
    expect(reconnect).toHaveBeenCalledOnce()

    await act(async () =>
      root.render(
        createElement(ServerSearchRow, {
          ...base,
          phase: 'complete',
          resultCount: 2,
          quotaWaitMs: 2_400
        })
      )
    )
    expect(container.textContent).toContain('2 more conversations from Gmail')
    expect(container.textContent).toContain('Quota wait 2s')
  } finally {
    await act(async () => root.unmount())
  }
})

it('allows an online retry after a connection failure and returns keyboard focus to the query', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const search = vi.fn()
  const focusQuery = vi.fn()
  try {
    await act(async () =>
      root.render(
        createElement(ServerSearchRow, {
          phase: 'offline',
          resultCount: 0,
          message: 'Connection failed',
          quotaWaitMs: 0,
          online: true,
          onSearch: search,
          onReconnect: vi.fn(),
          onFocusQuery: focusQuery
        })
      )
    )
    const button = container.querySelector('button')
    expect(button?.disabled).toBe(false)
    expect(button?.textContent).toContain('Try again')
    button?.click()
    expect(search).toHaveBeenCalledOnce()

    for (const key of ['Escape', 'Backspace', '/']) {
      button?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    expect(focusQuery).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
  }
})
