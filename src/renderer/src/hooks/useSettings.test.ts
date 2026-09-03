// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppSettings } from '../../../shared/settings'
import { useSettings } from './useSettings'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function settings(overrides: Partial<AppSettings>): AppSettings {
  return { unreadBadgeEnabled: true, launchAtLogin: false, ...overrides } as AppSettings
}

test('a slow response never overwrites a newer write', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let resolveLoad: ((value: AppSettings) => void) | null = null
  const writes: Array<{ value: unknown; resolve: (value: AppSettings) => void }> = []
  const getAll = vi.fn(
    () =>
      new Promise<AppSettings>((resolve) => {
        resolveLoad = resolve
      })
  )
  const set = vi.fn(
    (_key: string, value: unknown) =>
      new Promise<AppSettings>((resolve) => {
        writes.push({ value, resolve })
      })
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { settings: { getAll, set } } as unknown as Window['attn']
  })

  const errors: string[] = []
  const root = createRoot(document.createElement('div'))
  const states: ReturnType<typeof useSettings>[] = []
  function Harness(): null {
    states.push(useSettings((message) => errors.push(message)))
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    expect(states.at(-1)?.settings).toBeNull()

    // A write dispatched while the initial read is still in flight is newer:
    // the read must not paint the value the user just changed away from.
    act(() => states.at(-1)?.update('unreadBadgeEnabled', false))
    await act(async () => {
      resolveLoad?.(settings({ unreadBadgeEnabled: true }))
      await Promise.resolve()
    })
    expect(states.at(-1)?.settings).toBeNull()

    await act(async () => {
      writes[0]?.resolve(settings({ unreadBadgeEnabled: false }))
      await Promise.resolve()
    })
    expect(states.at(-1)?.settings?.unreadBadgeEnabled).toBe(false)

    // Two writes in flight: the older response is dropped, whichever order
    // the responses arrive in.
    act(() => states.at(-1)?.update('unreadBadgeEnabled', true))
    act(() => states.at(-1)?.update('launchAtLogin', true))
    // Optimistic application shows both immediately.
    expect(states.at(-1)?.settings).toMatchObject({ unreadBadgeEnabled: true, launchAtLogin: true })
    await act(async () => {
      writes[2]?.resolve(settings({ unreadBadgeEnabled: true, launchAtLogin: true }))
      writes[1]?.resolve(settings({ unreadBadgeEnabled: true, launchAtLogin: false }))
      await Promise.resolve()
    })
    expect(states.at(-1)?.settings).toMatchObject({ unreadBadgeEnabled: true, launchAtLogin: true })
    expect(errors).toEqual([])
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
