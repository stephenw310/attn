// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { useFocusThreadTarget } from './useFocusThreadTarget'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

type Target = {
  id: string
  kind: 'focus' | 'switch'
  accountId: string
  threadId: string | null
}

async function mount(options: {
  splitsReady?: boolean
  location?: { splitId: string; revision: number } | null
  focusIndex?: number | null
}) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let deliver: ((target: Target) => void) | null = null
  const acknowledge = vi.fn(async () => {})
  const getThreadLocation = vi.fn(async () => options.location ?? null)
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        onFocusThread: (listener: (target: Target) => void) => {
          deliver = listener
          return () => {
            deliver = null
          }
        },
        acknowledgeFocusThread: acknowledge
      },
      splits: { getThreadLocation }
    } as unknown as Window['attn']
  })
  const calls: string[] = []
  const focusInboxThread = vi.fn(async () => options.focusIndex ?? null)
  const setActiveSplitId = vi.fn()
  const switchAccount = vi.fn()
  const root = createRoot(document.createElement('div'))
  function Harness(): null {
    useFocusThreadTarget({
      account: 'one@attn.test',
      splitsReady: options.splitsReady ?? true,
      setActiveSplitId,
      focusInboxThread,
      switchView: (view, afterSwitch) => {
        calls.push(`switchView:${view}`)
        afterSwitch?.()
      },
      switchAccount,
      clearSelection: () => calls.push('clearSelection'),
      cancelPendingRestores: () => calls.push('cancelPendingRestores'),
      setSelectedIndex: (index) => calls.push(`index:${index}`),
      setReaderOpen: (open) => calls.push(`reader:${open}`),
      setDetachedDraftThread: () => calls.push('detach:null'),
      selectedThreadIdRef: { current: null }
    })
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    calls,
    acknowledge,
    getThreadLocation,
    focusInboxThread,
    setActiveSplitId,
    switchAccount,
    deliver: async (target: Target) => {
      await act(async () => {
        deliver?.(target)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    subscribed: () => deliver !== null,
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('waits for split bootstrap before subscribing', async () => {
  const harness = await mount({ splitsReady: false })
  try {
    expect(harness.subscribed()).toBe(false)
  } finally {
    await harness.unmount()
  }
})

test('a target for another account nudges the guarded switch and stays unacknowledged', async () => {
  const harness = await mount({})
  try {
    await harness.deliver({ id: 't1', kind: 'focus', accountId: 'two@attn.test', threadId: 'thread-1' })
    expect(harness.switchAccount).toHaveBeenCalledWith('two@attn.test')
    expect(harness.acknowledge).not.toHaveBeenCalled()

    await harness.deliver({ id: 't2', kind: 'switch', accountId: 'two@attn.test', threadId: null })
    expect(harness.switchAccount).toHaveBeenCalledTimes(2)
  } finally {
    await harness.unmount()
  }
})

test('a summary lands on the inbox and acknowledges once', async () => {
  const harness = await mount({})
  try {
    await harness.deliver({ id: 't3', kind: 'focus', accountId: 'one@attn.test', threadId: null })
    expect(harness.calls).toEqual(['switchView:inbox', 'clearSelection'])
    expect(harness.acknowledge).toHaveBeenCalledWith('t3')
  } finally {
    await harness.unmount()
  }
})

test('a thread target selects its split, opens the reader, then acknowledges', async () => {
  const harness = await mount({ location: { splitId: 'other', revision: 2 }, focusIndex: 4 })
  try {
    await harness.deliver({ id: 't4', kind: 'focus', accountId: 'one@attn.test', threadId: 'thread-9' })
    expect(harness.setActiveSplitId).toHaveBeenCalledWith('other')
    expect(harness.focusInboxThread).toHaveBeenCalledWith('thread-9', 'other', 2)
    expect(harness.calls).toContain('cancelPendingRestores')
    expect(harness.calls).toContain('index:4')
    expect(harness.calls).toContain('reader:true')
    expect(harness.acknowledge).toHaveBeenCalledWith('t4')
  } finally {
    await harness.unmount()
  }
})

test('a profile with no split setup keeps the whole-inbox path', async () => {
  const harness = await mount({ location: null, focusIndex: 1 })
  try {
    await harness.deliver({ id: 't5', kind: 'focus', accountId: 'one@attn.test', threadId: 'thread-3' })
    expect(harness.setActiveSplitId).not.toHaveBeenCalled()
    expect(harness.focusInboxThread).toHaveBeenCalledWith('thread-3', null)
    expect(harness.acknowledge).toHaveBeenCalledWith('t5')
  } finally {
    await harness.unmount()
  }
})

test('a targeted read that finds nothing leaves the request pending', async () => {
  const harness = await mount({ location: { splitId: 'other', revision: 2 }, focusIndex: null })
  try {
    await harness.deliver({ id: 't6', kind: 'focus', accountId: 'one@attn.test', threadId: 'thread-9' })
    expect(harness.acknowledge).not.toHaveBeenCalled()
    // It retries once with a fresh split id and revision before giving up.
    expect(harness.getThreadLocation).toHaveBeenCalledTimes(2)
  } finally {
    await harness.unmount()
  }
})
