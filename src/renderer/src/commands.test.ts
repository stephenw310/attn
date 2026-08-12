import { afterEach, describe, expect, test } from 'vitest'
import {
  COMMAND_SPECS,
  createCommand,
  findCommandByShortcut,
  isChordPrefix,
  listCommands,
  matchKey,
  readingScrollDelta,
  registerCommands
} from './commands'

const cleanups: Array<() => void> = []

function useCommands(commands: Parameters<typeof registerCommands>[0]): () => void {
  const dispose = registerCommands(commands)
  cleanups.push(dispose)
  return dispose
}

function key(
  value: string,
  options: Partial<Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}
): KeyboardEvent {
  return {
    key: value,
    code: options.code ?? '',
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false
  } as KeyboardEvent
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  expect(listCommands()).toHaveLength(0)
})

describe('command catalog', () => {
  test('contains the complete audited M1 semantic command inventory', () => {
    expect(Object.keys(COMMAND_SPECS)).toEqual([
      'navigate.next',
      'navigate.previous',
      'selection.toggle',
      'selection.extendNext',
      'selection.extendPrevious',
      'selection.clear',
      'conversation.open',
      'conversation.close',
      'message.trim.toggle',
      'view.inbox',
      'view.snoozed',
      'triage.archive',
      'triage.snooze',
      'triage.trash',
      'triage.spam',
      'triage.star',
      'triage.unread',
      'triage.label',
      'triage.undo'
    ])
  })

  test('rejects duplicate active ids', () => {
    useCommands([createCommand('navigate.next', () => {})])
    expect(() => registerCommands([createCommand('navigate.next', () => {})])).toThrow(
      'Duplicate command id: navigate.next'
    )
  })

  test('has no shortcut conflicts in overlapping contexts', () => {
    const entries = Object.entries(COMMAND_SPECS)
    const conflicts: string[] = []
    const concreteContexts = (context: (typeof COMMAND_SPECS)[keyof typeof COMMAND_SPECS]['context']) =>
      context === 'global' || context === 'mail' ? ['list', 'reader'] : [context]
    for (const [index, [leftId, left]] of entries.entries()) {
      for (const [rightId, right] of entries.slice(index + 1)) {
        const overlaps = concreteContexts(left.context).some((context) =>
          concreteContexts(right.context).includes(context)
        )
        const leftShortcut = 'shortcut' in left ? left.shortcut : undefined
        const rightShortcut = 'shortcut' in right ? right.shortcut : undefined
        if (
          overlaps &&
          leftShortcut !== undefined &&
          rightShortcut !== undefined &&
          leftShortcut.toLowerCase() === rightShortcut.toLowerCase()
        ) {
          conflicts.push(`${leftId}/${rightId}`)
        }
      }
    }
    expect(conflicts).toEqual([])
  })
})

describe('keyboard dispatch', () => {
  test('normalizes list arrows but keeps reader arrows available for scrolling', () => {
    useCommands([createCommand('navigate.next', () => {}), createCommand('navigate.previous', () => {})])
    expect(matchKey(key('ArrowDown'), 'list')?.id).toBe('navigate.next')
    expect(matchKey(key('ArrowUp'), 'list')?.id).toBe('navigate.previous')
    expect(matchKey(key('ArrowDown'), 'reader')).toBeNull()
    expect(matchKey(key('ArrowUp'), 'reader')).toBeNull()
    expect(readingScrollDelta(key('ArrowDown'), 800)).toBe(120)
    expect(readingScrollDelta(key('ArrowUp'), 800)).toBe(-120)
  })

  test('extends the selection with Shift+Arrow in both contexts', () => {
    useCommands([
      createCommand('selection.extendNext', () => {}),
      createCommand('selection.extendPrevious', () => {})
    ])
    for (const context of ['list', 'reader'] as const) {
      expect(matchKey(key('ArrowDown', { shiftKey: true }), context)?.id).toBe('selection.extendNext')
      expect(matchKey(key('ArrowUp', { shiftKey: true }), context)?.id).toBe('selection.extendPrevious')
    }
    // A shifted arrow is selection, never scrolling — the reader must not do both.
    expect(readingScrollDelta(key('ArrowDown', { shiftKey: true }), 800)).toBeNull()
    expect(readingScrollDelta(key('ArrowUp', { shiftKey: true }), 800)).toBeNull()
  })

  test('separates bare J/K from shifted range extension and rejects command modifiers', () => {
    useCommands([createCommand('navigate.next', () => {}), createCommand('selection.extendNext', () => {})])
    expect(matchKey(key('j'), 'reader')?.id).toBe('navigate.next')
    expect(matchKey(key('j', { shiftKey: true }), 'reader')?.id).toBe('selection.extendNext')
    expect(matchKey(key('j', { metaKey: true }), 'reader')).toBeNull()
    expect(matchKey(key('j', { ctrlKey: true }), 'list')).toBeNull()
    expect(matchKey(key('j', { altKey: true }), 'list')).toBeNull()
  })

  test('respects list, reader, mail, and global contexts', () => {
    useCommands([
      createCommand('conversation.open', () => {}),
      createCommand('conversation.close', () => {}),
      createCommand('triage.archive', () => {}),
      createCommand('triage.undo', () => {})
    ])
    expect(matchKey(key('Enter'), 'list')?.id).toBe('conversation.open')
    expect(matchKey(key('Enter'), 'reader')).toBeNull()
    expect(matchKey(key('Escape'), 'reader')?.id).toBe('conversation.close')
    expect(matchKey(key('e'), 'list')?.id).toBe('triage.archive')
    expect(matchKey(key('e'), 'reader')?.id).toBe('triage.archive')
    expect(matchKey(key('z'), 'list')?.id).toBe('triage.undo')
    expect(matchKey(key('z'), 'reader')?.id).toBe('triage.undo')
  })

  test('looks up registered chord commands instead of bypassing their handlers', () => {
    useCommands([createCommand('view.inbox', () => {}), createCommand('view.snoozed', () => {})])
    expect(findCommandByShortcut('g i', 'list')?.id).toBe('view.inbox')
    expect(findCommandByShortcut('G H', 'reader')?.id).toBe('view.snoozed')
    expect(matchKey(key('g'), 'list')).toBeNull()
  })

  test('derives chord prefixes from the registry rather than a hardcoded list', () => {
    expect(isChordPrefix('g', 'list')).toBe(false)
    useCommands([createCommand('view.inbox', () => {})])
    expect(isChordPrefix('g', 'list')).toBe(true)
    expect(isChordPrefix('G', 'reader')).toBe(true)
    // Registering a new chord must make its prefix live without a dispatch change.
    expect(isChordPrefix('m', 'list')).toBe(false)
    useCommands([createCommand('view.snoozed', () => {}, { shortcut: 'm t' })])
    expect(isChordPrefix('m', 'list')).toBe(true)
    expect(findCommandByShortcut('m t', 'list')?.id).toBe('view.snoozed')
    // A chord prefix is not itself a single-key shortcut.
    expect(matchKey(key('m'), 'list')).toBeNull()
  })

  test('keeps scrolling as an explicit non-command reader primitive', () => {
    expect(readingScrollDelta(key('PageDown'), 1000)).toBe(850)
    expect(readingScrollDelta(key('PageUp'), 1000)).toBe(-850)
    expect(readingScrollDelta(key(' ', { code: 'Space' }), 1000)).toBe(850)
    expect(readingScrollDelta(key(' ', { code: 'Space', shiftKey: true }), 1000)).toBe(-850)
    expect(readingScrollDelta(key('ArrowDown', { altKey: true }), 1000)).toBeNull()
    expect(readingScrollDelta(key('j'), 1000)).toBeNull()
  })
})
