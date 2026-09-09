// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { APP_SETTINGS_DEFAULTS } from '../../shared/settings'
import type { PaletteId } from '../../shared/theme'
import { ThemeProvider, useTheme } from './theme'

it('serializes palette writes and restores the last saved choice when a later write fails', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const original = Object.getOwnPropertyDescriptor(window, 'attn')
  let resolveFirst: ((value: typeof APP_SETTINGS_DEFAULTS) => void) | undefined
  const set = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    .mockRejectedValueOnce(new Error('storage failed'))
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { settings: { getAll: async () => ({ ...APP_SETTINGS_DEFAULTS, palette: 'linen' }), set } }
  })
  let choose: (palette: PaletteId) => void = () => {}
  function Controls() {
    const { setPalette } = useTheme()
    choose = setPalette
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ThemeProvider, null, createElement(Controls))))
    expect(document.documentElement.dataset.palette).toBe('linen')
    await act(async () => {
      choose('mist')
      choose('dusk')
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset.palette).toBe('dusk')
    await act(async () => resolveFirst?.({ ...APP_SETTINGS_DEFAULTS, palette: 'mist' }))
    expect(set).toHaveBeenCalledTimes(2)
    expect(document.documentElement.dataset.palette).toBe('mist')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
  } finally {
    await act(async () => root.unmount())
    if (original) Object.defineProperty(window, 'attn', original)
    else Reflect.deleteProperty(window, 'attn')
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment
  }
})
