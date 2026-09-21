// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { emptyMailtoPrefill, type PendingComposeTarget } from '../../../shared/mailto'
import { useMailtoTarget } from './useMailtoTarget'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function target(id = 1, email = 'alex@example.com'): PendingComposeTarget {
  return { id, prefill: { ...emptyMailtoPrefill(), to: [{ name: 'Alex', email }] } }
}

async function mount(options: { composerOpen?: boolean; opens?: boolean }) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let deliver: ((request: PendingComposeTarget) => void) | null = null
  const acknowledge = vi.fn(async () => {})
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        onComposeRequest: (listener: (request: PendingComposeTarget) => void) => {
          deliver = listener
          return () => {
            deliver = null
          }
        },
        acknowledgeComposeRequest: acknowledge
      }
    } as unknown as Window['attn']
  })
  const openComposer = vi.fn(async () => options.opens ?? true)
  const closePreferences = vi.fn()
  const toasts: string[] = []
  const root = createRoot(document.createElement('div'))
  function Harness(): null {
    useMailtoTarget({
      account: 'one@attn.test',
      composerOpen: options.composerOpen ?? false,
      openComposer,
      closePreferences,
      showToast: async (message) => {
        toasts.push(message)
      }
    })
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    acknowledge,
    openComposer,
    closePreferences,
    toasts,
    deliver: async (request: PendingComposeTarget) => {
      await act(async () => deliver?.(request))
    },
    unsubscribed: () => deliver === null,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('a link opens the composer prefilled and acknowledges only then', async () => {
  const harness = await mount({})
  try {
    const request = target()
    await harness.deliver(request)
    expect(harness.openComposer).toHaveBeenCalledWith(request.prefill)
    expect(harness.closePreferences).toHaveBeenCalledTimes(1)
    expect(harness.acknowledge).toHaveBeenCalledWith(1)
    expect(harness.toasts).toEqual([])
  } finally {
    await harness.unmount()
  }
})

test('a refused open leaves the link pending for the next tree', async () => {
  const harness = await mount({ opens: false })
  try {
    await harness.deliver(target())
    expect(harness.openComposer).toHaveBeenCalledTimes(1)
    expect(harness.acknowledge).not.toHaveBeenCalled()
  } finally {
    await harness.unmount()
  }
})

test('an open draft keeps the window: the link toasts and is consumed', async () => {
  const harness = await mount({ composerOpen: true })
  try {
    await harness.deliver(target(7))
    expect(harness.openComposer).not.toHaveBeenCalled()
    expect(harness.toasts).toEqual(['Close the open draft to write to alex@example.com'])
    expect(harness.acknowledge).toHaveBeenCalledWith(7)
  } finally {
    await harness.unmount()
  }
})

test('unmounting releases the subscription', async () => {
  const harness = await mount({})
  await harness.unmount()
  expect(harness.unsubscribed()).toBe(true)
})
