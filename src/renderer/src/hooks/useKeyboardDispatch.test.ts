// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createCommand, getCommandRegistrySnapshot, registerCommands } from '../commands'
import { CHORD_TIMEOUT_MS } from '../tuning'
import { isTextEntry, useKeyboardDispatch } from './useKeyboardDispatch'

type Options = Parameters<typeof useKeyboardDispatch>[0]

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  expect(getCommandRegistrySnapshot()).toHaveLength(0)
  vi.useRealTimers()
})

function register(commands: Parameters<typeof registerCommands>[0]): void {
  disposers.push(registerCommands(commands))
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

async function mount(overrides: Partial<Options> = {}): Promise<{
  render: (next: Partial<Options>) => Promise<void>
  chords: string[]
  unmount: () => Promise<void>
}> {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const chords: string[] = []
  const base: Options = {
    blocked: false,
    readerOpen: false,
    outboxOpen: false,
    snoozeOpen: false,
    onCloseSnooze: () => {},
    viewKey: 'inbox:list:mail',
    onPendingChordChange: (key) => chords.push(key ?? '(cleared)'),
    conversationScrollRef: createRef<HTMLDivElement>()
  }
  let current = { ...base, ...overrides }
  const root = createRoot(document.createElement('div'))
  function Harness(): null {
    useKeyboardDispatch(current)
    return null
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    chords,
    render: async (next) => {
      current = { ...current, ...next }
      await act(async () => root.render(createElement(Harness)))
    },
    unmount: async () => {
      await act(async () => root.unmount())
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('recognizes the controls that own raw keys', () => {
  const input = document.createElement('input')
  expect(isTextEntry(input)).toBe(true)
  expect(isTextEntry(document.createElement('textarea'))).toBe(true)
  expect(isTextEntry(document.createElement('button'))).toBe(false)
  expect(isTextEntry(null)).toBe(false)
  expect(isTextEntry(document.createTextNode('x'))).toBe(false)
})

test('arms a chord prefix, completes it, and disarms it on timeout', async () => {
  vi.useFakeTimers()
  const goInbox = vi.fn()
  register([createCommand('view.inbox', goInbox)])
  const harness = await mount()
  try {
    const armed = press(window, 'g')
    expect(armed.defaultPrevented).toBe(true)
    expect(harness.chords).toEqual(['g'])
    const completed = press(window, 'i')
    expect(completed.defaultPrevented).toBe(true)
    expect(goInbox).toHaveBeenCalledTimes(1)
    expect(harness.chords).toEqual(['g', '(cleared)'])

    // A prefix that is never completed disarms itself, and the key it would
    // have completed is no longer swallowed.
    press(window, 'g')
    expect(harness.chords).toEqual(['g', '(cleared)', 'g'])
    await act(async () => {
      vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1)
    })
    expect(harness.chords).toEqual(['g', '(cleared)', 'g', '(cleared)'])
    press(window, 'i')
    expect(goInbox).toHaveBeenCalledTimes(1)
  } finally {
    await harness.unmount()
  }
})

test('a view change and a modifier both disarm a pending chord', async () => {
  register([createCommand('view.inbox', () => {})])
  const harness = await mount()
  try {
    press(window, 'g')
    expect(harness.chords).toEqual(['g'])
    await harness.render({ viewKey: 'allMail:list:mail' })
    expect(harness.chords).toEqual(['g', '(cleared)'])

    press(window, 'g')
    press(window, 'Shift', { shiftKey: true })
    expect(harness.chords).toEqual(['g', '(cleared)', 'g', '(cleared)'])
  } finally {
    await harness.unmount()
  }
})

test('leaves keys to text entry and runs nothing while blocked', async () => {
  const archive = vi.fn()
  register([createCommand('triage.archive', archive)])
  const input = document.createElement('input')
  document.body.append(input)
  const harness = await mount()
  try {
    press(input, 'e')
    expect(archive).not.toHaveBeenCalled()
    press(window, 'e')
    expect(archive).toHaveBeenCalledTimes(1)

    await harness.render({ blocked: true })
    press(window, 'e')
    expect(archive).toHaveBeenCalledTimes(1)
  } finally {
    input.remove()
    await harness.unmount()
  }
})

test('keeps native Tab inside a menu or dialog and claims it on the mail canvas', async () => {
  const goInbox = vi.fn()
  register([createCommand('view.inbox', goInbox, { shortcutAliases: ['Tab'] })])
  // The account menu: a [role="menu"] popup whose rows are buttons, so Tab
  // keeps moving between them instead of switching mailbox (P9).
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const item = document.createElement('button')
  menu.append(item)
  const canvas = document.createElement('div')
  document.body.append(menu, canvas)
  const harness = await mount()
  try {
    const inMenu = press(item, 'Tab')
    expect(inMenu.defaultPrevented).toBe(false)
    expect(goInbox).not.toHaveBeenCalled()

    const onCanvas = press(canvas, 'Tab')
    expect(onCanvas.defaultPrevented).toBe(true)
    expect(goInbox).toHaveBeenCalledTimes(1)
  } finally {
    menu.remove()
    canvas.remove()
    await harness.unmount()
  }
})

test('an open snooze picker claims Escape ahead of the reader', async () => {
  const closeReader = vi.fn()
  const onCloseSnooze = vi.fn()
  register([createCommand('conversation.close', closeReader)])
  const harness = await mount({ readerOpen: true, snoozeOpen: true, onCloseSnooze })
  try {
    const claimed = press(window, 'Escape')
    expect(claimed.defaultPrevented).toBe(true)
    expect(onCloseSnooze).toHaveBeenCalledTimes(1)
    expect(closeReader).not.toHaveBeenCalled()

    // With the picker gone, the same key reaches the reader — even from a
    // stale focus inside an interactive control.
    await harness.render({ snoozeOpen: false })
    const button = document.createElement('button')
    document.body.append(button)
    press(button, 'Escape')
    expect(closeReader).toHaveBeenCalledTimes(1)
    button.remove()
  } finally {
    await harness.unmount()
  }
})
