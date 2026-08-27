// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
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

it('reports why Gmail search is unavailable offline', async () => {
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
          online: false
        })
      )
    )
    expect(container.querySelector('[role="status"]')?.textContent).toContain('back online')
    expect(container.querySelector('button')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('reports an auth pause and a quota-delayed completion', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const base = {
    resultCount: 0,
    message: 'Google authorization expired',
    quotaWaitMs: 0,
    online: true
  }
  try {
    await act(async () => root.render(createElement(ServerSearchRow, { ...base, phase: 'auth-required' })))
    expect(container.textContent).toContain('Press Enter to reconnect Google and search Gmail')

    await act(async () =>
      root.render(createElement(ServerSearchRow, { ...base, phase: 'auth-required', online: false }))
    )
    expect(container.textContent).toContain('when you are back online')

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

it('reports idle and retry states without becoming a second search action', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const base = {
    resultCount: 0,
    message: null,
    quotaWaitMs: 0,
    online: true
  }
  try {
    await act(async () => root.render(createElement(ServerSearchRow, { ...base, phase: 'idle' })))
    expect(container.textContent).toContain('Press Enter to search all of Gmail')
    expect(container.querySelector('button')).toBeNull()

    await act(async () =>
      root.render(createElement(ServerSearchRow, { ...base, phase: 'error', message: 'Connection failed' }))
    )
    expect(container.textContent).toContain('Press Enter to try again')
  } finally {
    await act(async () => root.unmount())
  }
})
