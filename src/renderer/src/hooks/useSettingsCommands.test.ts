// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { AppSettings } from '../../../shared/settings'
import { getCommandRegistrySnapshot } from '../commands'
import { useSettingsCommands } from './useSettingsCommands'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

async function mount(settings: AppSettings | null, mailClient = { supported: true, isDefault: true }) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const setDefaultMailClient = vi.fn(async () => mailClient)
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      ai: { setSetting: vi.fn(async () => {}) },
      app: { setDefaultMailClient }
    } as unknown as Window['attn']
  })
  const toasts: string[] = []
  const opened: Array<string | null> = []
  const splitRulesOpens: string[] = []
  const appWrites: Array<[string, unknown]> = []
  const accountWrites: Array<[string, unknown]> = []
  const aiDraft = vi.fn()
  let current = settings
  const root = createRoot(document.createElement('div'))
  function Harness(): null {
    useSettingsCommands({
      settings: current,
      openSettings: (control = null) => opened.push(control),
      openSplitRules: () => splitRulesOpens.push('split-rules'),
      openCheatSheet: () => {},
      updateAppSetting: (key, value) => appWrites.push([key, value]),
      updateAccountSetting: (key, value) => accountWrites.push([key, value]),
      requestAiDraft: aiDraft,
      showToast: async (message) => {
        toasts.push(message)
      }
    })
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    opened,
    splitRulesOpens,
    appWrites,
    accountWrites,
    aiDraft,
    toasts,
    setDefaultMailClient,
    setSettings: async (next: AppSettings | null) => {
      current = next
      await act(async () => root.render(createElement(Harness)))
    },
    run: async (id: string) => {
      const command = getCommandRegistrySnapshot().find((entry) => entry.id === id)
      if (!command) throw new Error(`missing ${id}`)
      await act(async () => command.run())
    },
    registered: () => getCommandRegistrySnapshot().map((command) => command.id),
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('deep links open the surface on their control and direct commands act at once', async () => {
  const harness = await mount({ unreadBadgeEnabled: true } as AppSettings)
  try {
    await harness.run('settings.syncLimit')
    await harness.run('snippets.manage')
    await harness.run('privacy.remoteImages.overrides')
    expect(harness.opened).toEqual(['syncLimit', 'snippets', 'remoteImages'])

    await harness.run('privacy.remoteImages.block')
    expect(harness.appWrites.at(-1)).toEqual(['remoteImagesBlocked', true])
    await harness.run('compose.attnFooter.disable')
    expect(harness.accountWrites.at(-1)).toEqual(['attnSignatureEnabled', false])
    await harness.run('composer.aiDraft')
    expect(harness.aiDraft).toHaveBeenCalledTimes(1)

    // Smart splits live in Split rules, so their command opens that manager
    // rather than a Settings page (F11, F15).
    await harness.run('ai.triageSettings')
    expect(harness.splitRulesOpens).toHaveLength(1)
    expect(harness.opened).toEqual(['syncLimit', 'snippets', 'remoteImages'])
  } finally {
    await harness.unmount()
  }
})

test('a toggle reads the value it is flipping when it runs, not when it registered', async () => {
  const harness = await mount({ unreadBadgeEnabled: true } as AppSettings)
  try {
    const before = harness.registered()
    await harness.run('settings.unreadBadge')
    expect(harness.appWrites.at(-1)).toEqual(['unreadBadgeEnabled', false])

    await harness.setSettings({ unreadBadgeEnabled: false } as AppSettings)
    await harness.run('settings.unreadBadge')
    expect(harness.appWrites.at(-1)).toEqual(['unreadBadgeEnabled', true])
    // The settings read landing must not churn the batch.
    expect(harness.registered()).toEqual(before)

    // Before the first read lands, the toggle assumes the shipped default.
    await harness.setSettings(null)
    await harness.run('settings.unreadBadge')
    expect(harness.appWrites.at(-1)).toEqual(['unreadBadgeEnabled', false])
  } finally {
    await harness.unmount()
  }
})

test('the default-mail-app command claims the registration and reports the answer', async () => {
  const harness = await mount({} as AppSettings)
  try {
    await harness.run('settings.defaultMailClient')
    expect(harness.setDefaultMailClient).toHaveBeenCalledTimes(1)
    expect(harness.toasts.at(-1)).toBe('Attn is the default email app')
  } finally {
    await harness.unmount()
  }
})

test('the default-mail-app command says so when the build cannot register', async () => {
  const harness = await mount({} as AppSettings, { supported: false, isDefault: false })
  try {
    await harness.run('settings.defaultMailClient')
    expect(harness.toasts.at(-1)).toContain('installed Attn')
  } finally {
    await harness.unmount()
  }
})
