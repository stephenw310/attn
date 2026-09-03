// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommandUsage } from '../../../shared/commandUsage'
import { createCommand, registerCommands } from '../commands'
import { CommandPalette } from './CommandPalette'

afterEach(() => {
  document.body.replaceChildren()
})

it('reloads usage instead of carrying ranking across account changes', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

  let stored: CommandUsage = { 'view.sent': { count: 10, lastUsedAt: 100 } }
  const getCommandUsage = vi.fn((_account: string) => Promise.resolve(stored))
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      settings: {
        getCommandUsage,
        setCommandUsage: vi.fn((_account: string, usage: CommandUsage) => Promise.resolve(usage))
      }
    }
  })
  const unregister = registerCommands([
    createCommand('view.inbox', vi.fn()),
    createCommand('view.sent', vi.fn())
  ])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  const openPalette = async (): Promise<void> => {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
      )
    })
  }

  try {
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          key: 'first',
          account: 'first@attn.test',
          context: 'list',
          onOpenChange: () => {}
        })
      )
    )
    await openPalette()
    expect(
      container.querySelector('[data-testid="command-palette-result"]')?.getAttribute('data-command-id')
    ).toBe('view.sent')

    stored = { 'view.inbox': { count: 10, lastUsedAt: 200 } }
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          key: 'second',
          account: 'second@attn.test',
          context: 'list',
          onOpenChange: () => {}
        })
      )
    )
    await openPalette()
    expect(
      container.querySelector('[data-testid="command-palette-result"]')?.getAttribute('data-command-id')
    ).toBe('view.inbox')
    expect(getCommandUsage.mock.calls).toEqual([['first@attn.test'], ['second@attn.test']])
  } finally {
    await act(async () => root.unmount())
    unregister()
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

it('refreshes rows and callbacks when the command registry changes while open', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      settings: {
        getCommandUsage: vi.fn(() => Promise.resolve({})),
        setCommandUsage: vi.fn((_account: string, usage: CommandUsage) => Promise.resolve(usage))
      }
    }
  })
  const oldRun = vi.fn()
  const newRun = vi.fn()
  let unregister = registerCommands([createCommand('view.sent', oldRun)])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () =>
      root.render(
        createElement(CommandPalette, { account: 'seed@attn.test', context: 'list', onOpenChange: () => {} })
      )
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    await act(async () => {
      unregister()
      unregister = registerCommands([createCommand('view.sent', newRun)])
    })
    await act(async () => {
      ;(container.querySelector('[data-command-id="view.sent"]') as HTMLButtonElement).click()
    })
    expect(oldRun).not.toHaveBeenCalled()
    expect(newRun).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    unregister()
    container.remove()
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
