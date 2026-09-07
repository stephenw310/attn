// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import {
  type ActiveCommandContext,
  COMMAND_SPECS,
  type CommandContext,
  commandMatchesContext,
  commandTitle,
  getCommandRegistrySnapshot,
  subscribeCommandRegistry
} from '../commands'
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
  footerCollapsed: false,
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
  toggleFooter: noop,
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

/**
 * The static specs are collision-checked in `commands.test.ts`, but the
 * registry the user actually types against also carries commands minted at
 * runtime: one per split, and `Mod+1..9` for the first nine accounts. This
 * checks the union — runtime commands against each other, against the specs
 * the shell registered, and against the specs it did not (a composer or
 * settings shortcut is still a shortcut this registry could grow into).
 */
interface ShortcutOwner {
  id: string
  context: CommandContext
  allowInComposer?: boolean
  shortcuts: readonly string[]
}

function shortcutOwners(): ShortcutOwner[] {
  const registered: ShortcutOwner[] = getCommandRegistrySnapshot().map((command) => ({
    id: command.id,
    context: command.context,
    ...(command.allowInComposer === undefined ? {} : { allowInComposer: command.allowInComposer }),
    shortcuts: [...(command.shortcut ? [command.shortcut] : []), ...(command.shortcutAliases ?? [])]
  }))
  const registeredIds = new Set(registered.map((owner) => owner.id))
  const unregistered: ShortcutOwner[] = Object.entries(COMMAND_SPECS)
    .filter(([id]) => !registeredIds.has(id))
    .map(([id, spec]) => ({
      id,
      context: spec.context,
      ...('allowInComposer' in spec ? { allowInComposer: spec.allowInComposer } : {}),
      shortcuts: [
        ...('shortcut' in spec && spec.shortcut ? [spec.shortcut] : []),
        ...('shortcutAliases' in spec ? spec.shortcutAliases : [])
      ]
    }))
  return [...registered, ...unregistered]
}

function shortcutConflicts(context: ActiveCommandContext): string[] {
  const conflicts: string[] = []
  const seen = new Map<string, string>()
  for (const owner of shortcutOwners()) {
    if (!commandMatchesContext(owner, context)) continue
    for (const shortcut of owner.shortcuts) {
      // Inside the composer a composer verb deliberately outranks a global
      // that shares its keystroke (`Mod+B` is Bold while writing, the sidebar
      // toggle everywhere else), so the two tiers are checked apart. Every
      // other context is flat: the first registration would simply win.
      const tier = context === 'composer' && owner.context !== 'composer' ? 'global' : 'command'
      const key = `${tier}:${shortcut.toLowerCase()}`
      const existing = seen.get(key)
      if (existing) conflicts.push(`${existing} and ${owner.id} share ${shortcut} in ${context}`)
      else seen.set(key, owner.id)
    }
  }
  return conflicts
}

const CONTEXTS: ActiveCommandContext[] = ['list', 'reader', 'outbox', 'composer']

test('no two registered shortcuts collide in one context', async () => {
  await withHarness(async (render) => {
    await render(options({}))
    for (const context of CONTEXTS) expect(shortcutConflicts(context)).toEqual([])
  })
})

test('the runtime split and account commands claim no key twice', async () => {
  const accounts = Array.from({ length: 10 }, (_, index) => ({
    id: `account-${index}@attn.test`,
    email: `account-${index}@attn.test`
  }))
  await withHarness(async (render) => {
    // Ten accounts and a full rule set: `Mod+1..9` is handed out to the first
    // nine in switcher order, and every split mints a `Go to:` command.
    await render(
      options({
        accountCommands: { ...BASE.accountCommands, accounts, activeAccountId: accounts[0]?.id ?? null },
        splitCommands: {
          ...BASE.splitCommands,
          goTo: ['Important', 'Everything else', 'Newsletters', 'Receipts'].map((name) => ({
            id: name.toLowerCase(),
            name,
            run: noop
          }))
        }
      })
    )
    for (const context of CONTEXTS) expect(shortcutConflicts(context)).toEqual([])

    const snapshot = getCommandRegistrySnapshot()
    const switchers = snapshot.filter((command) => command.id.startsWith('account.switch:'))
    expect(switchers.map((command) => command.shortcut)).toEqual([
      'Mod+1',
      'Mod+2',
      'Mod+3',
      'Mod+4',
      'Mod+5',
      'Mod+6',
      'Mod+7',
      'Mod+8',
      'Mod+9',
      undefined
    ])
    // Splits ride the palette and Tab, never a digit of their own.
    const splitGoTo = snapshot.filter((command) => command.id.startsWith('split.goto:'))
    expect(splitGoTo).toHaveLength(4)
    expect(splitGoTo.every((command) => command.shortcut === undefined)).toBe(true)
  })
})
