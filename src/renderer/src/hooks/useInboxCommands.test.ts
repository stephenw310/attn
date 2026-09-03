// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { commandTitle, getCommandRegistrySnapshot, subscribeCommandRegistry } from '../commands'
import { useInboxCommands } from './useInboxCommands'

type Options = Parameters<typeof useInboxCommands>[0]

const noop = (): void => {}

// One base object, so a re-render only changes what the override names — the
// shell memoizes `splitCommands` and `accountCommands` for the same reason.
const BASE = (() => ({
  hasSelection: true,
  selectedRef: { current: { id: 'thread-1' } as { id: string } | undefined },
  selectedCount: 0,
  readerOpen: false,
  view: 'inbox',
  searchOpen: false,
  searchBrowsing: false,
  sidebarCollapsed: false,
  starOnRef: { current: true as boolean },
  markUnreadOnRef: { current: true as boolean },
  moveAllowed: true,
  preserveSelectionOnRefreshRef: { current: true },
  navigateNext: noop,
  navigatePrevious: noop,
  clearSelection: noop,
  toggleSelection: noop,
  extendSelectionBy: noop,
  openSelected: noop,
  closeReader: noop,
  switchView: noop,
  openOutbox: noop,
  closeOutbox: noop,
  discardSelectedDraft: null,
  toggleSidebar: noop,
  openSearch: noop,
  focusSearchQuery: noop,
  searchAllEnabled: false,
  submitSearch: noop,
  clearSearch: noop,
  triage: noop,
  openSnooze: noop,
  snoozeAt: noop,
  openLabel: noop,
  openMove: noop,
  markNotDone: noop,
  openComposer: noop,
  openReply: noop,
  openMessageOrReplyAll: noop,
  showToast: async () => {},
  reopenUndoDraft: noop,
  splitCommands: {
    previous: noop,
    next: noop,
    manage: noop,
    goTo: [
      { id: 'important', name: 'Important', run: noop },
      { id: 'other', name: 'Everything else', run: noop }
    ]
  },
  accountCommands: {
    accounts: [
      { id: 'one@attn.test', email: 'one@attn.test' },
      { id: 'two@attn.test', email: 'two@attn.test' }
    ],
    activeAccountId: 'one@attn.test',
    switchTo: noop,
    add: noop,
    remove: noop
  }
}))() satisfies Options

function options(overrides: Partial<Options>): Options {
  return { ...BASE, ...overrides }
}

async function withHarness(
  run: (render: (next: Options) => Promise<void>, registrations: () => number) => Promise<void>
): Promise<void> {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let notifications = 0
  const unsubscribe = subscribeCommandRegistry(() => {
    notifications += 1
  })
  const root = createRoot(document.createElement('div'))
  let current = options({})
  function Harness(): null {
    useInboxCommands(current)
    return null
  }
  try {
    await run(
      async (next) => {
        current = next
        await act(async () => root.render(createElement(Harness)))
      },
      () => notifications
    )
  } finally {
    await act(async () => root.unmount())
    unsubscribe()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous
  }
}

test('registers once per context change, not per focused row', async () => {
  await withHarness(async (render, registrations) => {
    await render(options({}))
    const afterMount = registrations()
    expect(afterMount).toBeGreaterThan(0)

    // J moves the focused row: the selection, the index, and the star /
    // mark-unread verbs all follow the row's flags. None of that may
    // unregister and re-register the batch (P1).
    BASE.selectedRef.current = { id: 'thread-2' }
    BASE.starOnRef.current = false
    BASE.markUnreadOnRef.current = false
    await render(options({}))
    expect(registrations()).toBe(afterMount)

    // A background list refresh replaces the stable callbacks' inputs, not the
    // callbacks themselves, so it is equally invisible to the registry.
    await render(options({}))
    expect(registrations()).toBe(afterMount)

    // The titles still answer for the row on screen now.
    const star = getCommandRegistrySnapshot().find((command) => command.id === 'triage.star')
    const unread = getCommandRegistrySnapshot().find((command) => command.id === 'triage.unread')
    expect(star && commandTitle(star)).toBe('Unstar')
    expect(unread && commandTitle(unread)).toBe('Mark read')
    BASE.starOnRef.current = true
    expect(star && commandTitle(star)).toBe('Star')

    // Opening the reader is a context change: the batch is meant to swap then.
    await render(options({ readerOpen: true }))
    expect(registrations()).toBeGreaterThan(afterMount)
  })
})

test('no two registered shortcuts collide in one context', async () => {
  await withHarness(async (render) => {
    await render(options({}))
    const contexts = ['list', 'reader', 'outbox'] as const
    for (const context of contexts) {
      const seen = new Map<string, string>()
      for (const command of getCommandRegistrySnapshot()) {
        const shortcuts = [
          ...(command.shortcut ? [command.shortcut] : []),
          ...(command.shortcutAliases ?? [])
        ]
        for (const shortcut of shortcuts) {
          const key = shortcut.toLowerCase()
          const existing = seen.get(key)
          expect(
            existing === undefined,
            `${command.id} and ${existing} share ${shortcut} in ${context}`
          ).toBe(true)
          seen.set(key, command.id)
        }
      }
    }
  })
})
