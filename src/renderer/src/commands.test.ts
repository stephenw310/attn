import { afterEach, describe, expect, test } from 'vitest'
import {
  COMMAND_SPECS,
  chordKey,
  createCommand,
  createDynamicSplitCommand,
  findCommandByShortcut,
  isChordPrefix,
  listChordCompletions,
  listCommands,
  listFooterHints,
  matchComposerKey,
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
  options: Partial<
    Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'repeat' | 'shiftKey'>
  > = {}
): KeyboardEvent {
  return {
    key: value,
    code: options.code ?? '',
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    repeat: options.repeat ?? false,
    shiftKey: options.shiftKey ?? false
  } as KeyboardEvent
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  expect(listCommands()).toHaveLength(0)
})

describe('command catalog', () => {
  test('contains the complete audited semantic command inventory', () => {
    expect(Object.keys(COMMAND_SPECS)).toEqual([
      'palette.open',
      'navigate.next',
      'navigate.previous',
      'selection.toggle',
      'selection.extendNext',
      'selection.extendPrevious',
      'selection.clear',
      'conversation.open',
      'conversation.close',
      'message.next',
      'message.previous',
      'message.toggle',
      'message.trim.toggle',
      'sync.retry',
      'sync.error.copy',
      'search.open',
      'search.focusQuery',
      'search.allGmail',
      'search.submit',
      'search.clear',
      'split.previous',
      'split.next',
      'split.manage',
      'account.add',
      'theme.system',
      'theme.dispatch-dark',
      'theme.dispatch-light',
      'theme.midnight',
      'theme.sand',
      'view.inbox',
      'view.allMail',
      'view.sent',
      'view.starred',
      'view.snoozed',
      'view.drafts',
      'view.spam',
      'view.trash',
      'view.outbox',
      'layout.sidebar.toggle',
      'outbox.open',
      'outbox.close',
      'draft.discard',
      'composer.new',
      'composer.reply',
      'composer.replyAll',
      'composer.forward',
      'composer.close',
      'composer.discard',
      'composer.send',
      'composer.attach',
      'composer.removeAttachment',
      'composer.bold',
      'composer.italic',
      'composer.underline',
      'composer.strikethrough',
      'composer.fontFamily',
      'composer.fontSize',
      'composer.textColor',
      'composer.backgroundColor',
      'composer.alignLeft',
      'composer.alignCenter',
      'composer.alignRight',
      'composer.bullets',
      'composer.numbering',
      'composer.quote',
      'composer.link',
      'triage.archive',
      'triage.notDone',
      'triage.snooze',
      'triage.trash',
      'triage.spam',
      'triage.star',
      'triage.unread',
      'triage.move',
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
      context === 'global'
        ? ['list', 'reader', 'outbox']
        : context === 'navigation'
          ? ['list', 'reader', 'outbox']
          : context === 'mail'
            ? ['list', 'reader']
            : [context]
    for (const [index, [leftId, left]] of entries.entries()) {
      for (const [rightId, right] of entries.slice(index + 1)) {
        const overlaps = concreteContexts(left.context).some((context) =>
          concreteContexts(right.context).includes(context)
        )
        const leftShortcuts = [
          ...('shortcut' in left && left.shortcut ? [left.shortcut] : []),
          ...('shortcutAliases' in left ? left.shortcutAliases : [])
        ]
        const rightShortcuts = [
          ...('shortcut' in right && right.shortcut ? [right.shortcut] : []),
          ...('shortcutAliases' in right ? right.shortcutAliases : [])
        ]
        if (
          overlaps &&
          leftShortcuts.some((leftShortcut) =>
            rightShortcuts.some((rightShortcut) => leftShortcut.toLowerCase() === rightShortcut.toLowerCase())
          )
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
    expect(matchKey(key('ArrowDown'), 'outbox')?.id).toBe('navigate.next')
    expect(matchKey(key('ArrowUp'), 'outbox')?.id).toBe('navigate.previous')
    expect(readingScrollDelta(key('ArrowDown'), 800)).toBe(120)
    expect(readingScrollDelta(key('ArrowUp'), 800)).toBe(-120)
  })

  test('moves between inbox splits with Tab while preserving direction and context', () => {
    useCommands([createCommand('split.next', () => {}), createCommand('split.previous', () => {})])
    expect(matchKey(key('Tab'), 'list')?.id).toBe('split.next')
    expect(matchKey(key('Tab', { shiftKey: true }), 'list')?.id).toBe('split.previous')
    expect(matchKey(key('Tab'), 'reader')).toBeNull()
    expect(matchComposerKey(key('Tab'))).toBeNull()
  })

  test('accepts Tab as a contextual Inbox alias without replacing the G I chord', () => {
    useCommands([createCommand('view.inbox', () => {}, { shortcutAliases: ['Tab'] })])
    expect(matchKey(key('Tab'), 'list')?.id).toBe('view.inbox')
    expect(matchKey(key('Tab', { shiftKey: true }), 'list')).toBeNull()
    expect(findCommandByShortcut('g i', 'list')?.id).toBe('view.inbox')
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

  test('dispatches the sidebar modifier shortcut without leaking modifiers to bare commands', () => {
    useCommands([createCommand('layout.sidebar.toggle', () => {}), createCommand('triage.archive', () => {})])
    expect(matchKey(key('b', { metaKey: true }), 'list')?.id).toBe('layout.sidebar.toggle')
    expect(matchKey(key('b', { ctrlKey: true }), 'reader')?.id).toBe('layout.sidebar.toggle')
    expect(matchKey(key('b'), 'list')).toBeNull()
    expect(matchKey(key('b', { metaKey: true, shiftKey: true }), 'list')).toBeNull()
    expect(matchKey(key('e', { metaKey: true }), 'list')).toBeNull()
  })

  test('dispatches only registered composer modifier shortcuts in composer context', () => {
    useCommands([
      createCommand('draft.discard', () => {}),
      createCommand('composer.close', () => {}),
      createCommand('composer.discard', () => {}),
      createCommand('composer.send', () => {}),
      createCommand('composer.link', () => {})
    ])
    expect(matchKey(key('d', { metaKey: true, shiftKey: true }), 'list')?.id).toBe('draft.discard')
    expect(matchKey(key('d', { ctrlKey: true, shiftKey: true }), 'reader')).toBeNull()
    expect(matchComposerKey(key('Escape'))?.id).toBe('composer.close')
    expect(matchComposerKey(key('d', { metaKey: true, shiftKey: true }))?.id).toBe('composer.discard')
    expect(matchComposerKey(key('d', { ctrlKey: true, shiftKey: true }))?.id).toBe('composer.discard')
    expect(matchComposerKey(key('Enter', { metaKey: true }))?.id).toBe('composer.send')
    expect(matchComposerKey(key('k', { ctrlKey: true, shiftKey: true }))?.id).toBe('composer.link')
    expect(matchComposerKey(key('k', { ctrlKey: true }))).toBeNull()
    expect(matchComposerKey(key('k', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
  })

  test('respects list, reader, mail, and global contexts', () => {
    useCommands([
      createCommand('conversation.open', () => {}),
      createCommand('conversation.close', () => {}),
      createCommand('triage.archive', () => {}),
      createCommand('triage.notDone', () => {}),
      createCommand('triage.undo', () => {})
    ])
    expect(matchKey(key('Enter'), 'list')?.id).toBe('conversation.open')
    expect(matchKey(key('Enter'), 'reader')).toBeNull()
    expect(matchKey(key('Escape'), 'reader')?.id).toBe('conversation.close')
    expect(matchKey(key('e'), 'list')?.id).toBe('triage.archive')
    expect(matchKey(key('e'), 'reader')?.id).toBe('triage.archive')
    expect(matchKey(key('E', { shiftKey: true }), 'list')?.id).toBe('triage.notDone')
    expect(matchKey(key('E', { shiftKey: true }), 'reader')?.id).toBe('triage.notDone')
    expect(matchKey(key('z'), 'list')?.id).toBe('triage.undo')
    expect(matchKey(key('z'), 'reader')?.id).toBe('triage.undo')
  })

  test('uses Enter as a reader-only alias for reply all while retaining A', () => {
    useCommands([createCommand('conversation.open', () => {}), createCommand('composer.replyAll', () => {})])
    expect(matchKey(key('Enter'), 'list')?.id).toBe('conversation.open')
    expect(matchKey(key('Enter'), 'reader')?.id).toBe('composer.replyAll')
    expect(matchKey(key('a'), 'reader')?.id).toBe('composer.replyAll')
    expect(matchKey(key('a'), 'list')).toBeNull()
  })

  test('binds N, P, and O only in the reader', () => {
    useCommands([
      createCommand('message.next', () => {}),
      createCommand('message.previous', () => {}),
      createCommand('message.toggle', () => {})
    ])
    expect(matchKey(key('n'), 'reader')?.id).toBe('message.next')
    expect(matchKey(key('p'), 'reader')?.id).toBe('message.previous')
    expect(matchKey(key('o'), 'reader')?.id).toBe('message.toggle')
    expect(matchKey(key('n'), 'list')).toBeNull()
    expect(matchKey(key('p'), 'outbox')).toBeNull()
  })

  test('can expose reply and forward in list context for the focused conversation', () => {
    useCommands([
      createCommand('composer.reply', () => {}, { context: 'list' }),
      createCommand('composer.forward', () => {}, { context: 'list' })
    ])
    expect(matchKey(key('r'), 'list')?.id).toBe('composer.reply')
    expect(matchKey(key('f'), 'list')?.id).toBe('composer.forward')
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

  test('keeps dynamic split commands palette-only', () => {
    useCommands([
      createDynamicSplitCommand('preset:github', 'Go to: GitHub', () => {}),
      createDynamicSplitCommand('custom:news', 'Go to: News', () => {})
    ])
    expect(listCommands().map((command) => command.id)).toEqual([
      'split.goto:preset:github',
      'split.goto:custom:news'
    ])
    expect(isChordPrefix('g', 'list')).toBe(false)
    expect(findCommandByShortcut('g 2', 'list')).toBeNull()
    expect(findCommandByShortcut('g 6', 'reader')).toBeNull()
  })

  test('derives ordered chord-guide completions from active registry commands', () => {
    useCommands([
      createCommand('view.trash', () => {}),
      createCommand('view.inbox', () => {}),
      createCommand('view.drafts', () => {}),
      createDynamicSplitCommand('preset:github', 'Go to: GitHub', () => {}),
      createDynamicSplitCommand('custom:news', 'Go to: News', () => {})
    ])

    expect(listChordCompletions('g', 'list')).toEqual([
      { commandId: 'view.inbox', key: 'i', label: 'Inbox' },
      { commandId: 'view.drafts', key: 'd', label: 'Drafts' },
      { commandId: 'view.trash', key: 'r', label: 'Trash' }
    ])
  })

  test('lists only registered fixed-mailbox completions', () => {
    useCommands([createCommand('view.inbox', () => {}), createCommand('view.allMail', () => {})])
    expect(listChordCompletions('g', 'reader')).toEqual([
      { commandId: 'view.inbox', key: 'i', label: 'Inbox' },
      { commandId: 'view.allMail', key: 'a', label: 'All Mail' }
    ])
  })

  test('derives minimal footer hints and groups paired navigation commands', () => {
    useCommands([
      createCommand('palette.open', () => {}),
      createCommand('composer.new', () => {}),
      createCommand('navigate.next', () => {}),
      createCommand('navigate.previous', () => {}),
      createCommand('conversation.open', () => {}),
      createCommand('triage.archive', () => {}),
      createCommand('triage.snooze', () => {}),
      createCommand('triage.move', () => {}),
      createCommand('triage.undo', () => {})
    ])
    expect(listFooterHints('list')).toEqual([
      { id: 'navigate', label: 'navigate', order: 10, shortcuts: ['j', 'k'] },
      { id: 'open', label: 'open', order: 20, shortcuts: ['Enter'] },
      { id: 'done', label: 'done', order: 30, shortcuts: ['e'] },
      { id: 'compose', label: 'compose', order: 40, shortcuts: ['c'] },
      { id: 'undo', label: 'undo', order: 50, shortcuts: ['z'] },
      { id: 'snooze', label: 'snooze', order: 60, shortcuts: ['h'] },
      { id: 'move', label: 'move', order: 70, shortcuts: ['v'] },
      { id: 'palette', label: 'command palette', order: 80, shortcuts: ['Mod+K'] }
    ])
  })

  test('shows primary reader and Drafts actions only in their registered contexts', () => {
    const disposeReader = useCommands([
      createCommand('composer.reply', () => {}),
      createCommand('composer.replyAll', () => {}),
      createCommand('composer.forward', () => {}),
      createCommand('triage.archive', () => {}),
      createCommand('triage.snooze', () => {}),
      createCommand('triage.move', () => {}),
      createCommand('navigate.next', () => {}),
      createCommand('navigate.previous', () => {}),
      createCommand('conversation.close', () => {})
    ])
    expect(listFooterHints('reader')).toEqual([
      { id: 'reply', label: 'reply', order: 10, shortcuts: ['r'] },
      { id: 'reply-all', label: 'reply all', order: 11, shortcuts: ['a'] },
      { id: 'forward', label: 'forward', order: 12, shortcuts: ['f'] },
      { id: 'done', label: 'done', order: 20, shortcuts: ['e'] },
      { id: 'snooze', label: 'snooze', order: 30, shortcuts: ['h'] },
      { id: 'move', label: 'move', order: 40, shortcuts: ['v'] },
      { id: 'navigate', label: 'next / previous', order: 50, shortcuts: ['j', 'k'] },
      { id: 'back', label: 'back to list', order: 60, shortcuts: ['Escape'] }
    ])
    disposeReader()

    useCommands([
      createCommand('palette.open', () => {}),
      createCommand('composer.new', () => {}),
      createCommand('navigate.next', () => {}),
      createCommand('navigate.previous', () => {}),
      createCommand('conversation.open', () => {}),
      createCommand('draft.discard', () => {}),
      createCommand('triage.undo', () => {})
    ])
    expect(listFooterHints('list')).toEqual([
      { id: 'navigate', label: 'navigate', order: 10, shortcuts: ['j', 'k'] },
      { id: 'open', label: 'open', order: 20, shortcuts: ['Enter'] },
      {
        id: 'delete-draft',
        label: 'delete draft',
        order: 30,
        shortcuts: ['Mod+Shift+D']
      },
      { id: 'compose', label: 'compose', order: 40, shortcuts: ['c'] },
      { id: 'undo', label: 'undo', order: 50, shortcuts: ['z'] },
      { id: 'palette', label: 'command palette', order: 80, shortcuts: ['Mod+K'] }
    ])
  })

  test('requires unmodified keys for chord prefixes and completions', () => {
    expect(chordKey(key('g'))).toBe('g')
    expect(chordKey(key('G', { shiftKey: true }))).toBeNull()
    expect(chordKey(key('I', { shiftKey: true }))).toBeNull()
    expect(chordKey(key('h', { ctrlKey: true }))).toBeNull()
    expect(chordKey(key('h', { metaKey: true }))).toBeNull()
    expect(chordKey(key('h', { altKey: true }))).toBeNull()
    expect(chordKey(key('g', { repeat: true }))).toBeNull()
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
