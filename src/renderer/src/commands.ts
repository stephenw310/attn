export type CommandContext = 'list' | 'reader' | 'mail' | 'composer' | 'global'

interface CommandSpec {
  title: string
  shortcut?: string
  context: CommandContext
}

export const COMMAND_SPECS = {
  'navigate.next': { title: 'Next conversation', shortcut: 'j', context: 'mail' },
  'navigate.previous': { title: 'Previous conversation', shortcut: 'k', context: 'mail' },
  'selection.toggle': { title: 'Toggle selection', shortcut: 'x', context: 'mail' },
  'selection.extendNext': {
    title: 'Extend selection to next conversation',
    shortcut: 'Shift+J',
    context: 'mail'
  },
  'selection.extendPrevious': {
    title: 'Extend selection to previous conversation',
    shortcut: 'Shift+K',
    context: 'mail'
  },
  'selection.clear': { title: 'Clear selection', shortcut: 'Escape', context: 'list' },
  'conversation.open': { title: 'Open conversation', shortcut: 'Enter', context: 'list' },
  'conversation.close': { title: 'Back to conversation list', shortcut: 'Escape', context: 'reader' },
  'message.trim.toggle': { title: 'Show or hide trimmed message content', context: 'reader' },
  'sync.retry': { title: 'Retry mail sync', context: 'global' },
  'sync.error.copy': { title: 'Copy sync error details', context: 'global' },
  'view.inbox': { title: 'Go to Inbox', shortcut: 'g i', context: 'global' },
  'view.snoozed': { title: 'Go to Snoozed', shortcut: 'g h', context: 'global' },
  'composer.new': { title: 'New message', shortcut: 'c', context: 'global' },
  'composer.close': { title: 'Save and close draft', shortcut: 'Escape', context: 'composer' },
  'composer.discard': { title: 'Discard draft', context: 'composer' },
  'composer.send': { title: 'Send message', shortcut: 'Mod+Enter', context: 'composer' },
  'composer.bold': { title: 'Bold', shortcut: 'Mod+B', context: 'composer' },
  'composer.italic': { title: 'Italic', shortcut: 'Mod+I', context: 'composer' },
  'composer.underline': { title: 'Underline', shortcut: 'Mod+U', context: 'composer' },
  'composer.bullets': { title: 'Bulleted list', context: 'composer' },
  'composer.numbering': { title: 'Numbered list', context: 'composer' },
  'composer.quote': { title: 'Block quote', context: 'composer' },
  'composer.link': { title: 'Add link', shortcut: 'Mod+Shift+K', context: 'composer' },
  'triage.archive': { title: 'Mark done', shortcut: 'e', context: 'mail' },
  'triage.snooze': { title: 'Snooze / remind me later', shortcut: 'h', context: 'mail' },
  'triage.trash': { title: 'Move to trash', shortcut: '#', context: 'mail' },
  'triage.spam': { title: 'Mark as spam', shortcut: '!', context: 'mail' },
  'triage.star': { title: 'Star', shortcut: 's', context: 'mail' },
  'triage.unread': { title: 'Mark unread', shortcut: 'u', context: 'mail' },
  'triage.label': { title: 'Label', shortcut: 'l', context: 'mail' },
  'triage.undo': { title: 'Undo', shortcut: 'z', context: 'global' }
} as const satisfies Record<string, CommandSpec>

export type CommandId = keyof typeof COMMAND_SPECS

export interface Command extends CommandSpec {
  id: CommandId
  run: () => void
}

const commands: Command[] = []

export function createCommand(
  id: CommandId,
  run: () => void,
  overrides: Partial<Pick<Command, 'title' | 'shortcut' | 'context'>> = {}
): Command {
  return { id, ...COMMAND_SPECS[id], ...overrides, run }
}

export function registerCommands(next: Command[]): () => void {
  const nextIds = new Set<CommandId>()
  for (const command of next) {
    if (nextIds.has(command.id) || commands.some((registered) => registered.id === command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`)
    }
    nextIds.add(command.id)
  }
  commands.push(...next)
  return () => {
    for (const command of next) {
      const index = commands.indexOf(command)
      if (index >= 0) commands.splice(index, 1)
    }
  }
}

export function listCommands(): readonly Command[] {
  return commands
}

function normalizedKey(event: KeyboardEvent, context: 'list' | 'reader'): string {
  // Arrows alias to J/K so navigation and range selection accept either. A bare
  // arrow in the reader scrolls instead — readingScrollDelta claims it before
  // dispatch reaches here — but Shift+Arrow keeps extending the selection in
  // both contexts rather than becoming a dead key while reading.
  const aliasesArrows = context === 'list' || event.shiftKey
  if (aliasesArrows && event.key === 'ArrowDown') return 'j'
  if (aliasesArrows && event.key === 'ArrowUp') return 'k'
  return event.key.toLowerCase()
}

function matchesShortcut(event: KeyboardEvent, shortcut: string, context: 'list' | 'reader'): boolean {
  if (shortcut.includes(' ')) return false
  const normalizedShortcut = shortcut.toLowerCase()
  const expectsShift = normalizedShortcut.startsWith('shift+')
  const expectedKey = expectsShift ? normalizedShortcut.slice('shift+'.length) : normalizedShortcut
  if (expectedKey !== normalizedKey(event, context)) return false
  if (expectsShift) return event.shiftKey

  // Shift is part of the keystroke for printable symbols such as # and !, but it
  // distinguishes J/K navigation from Shift+J/K range selection. Bare-letter
  // shortcuts deliberately decline Shift so that namespace stays reserved for
  // future combinations without changing muscle memory later.
  const isLetter = /^[a-z]$/.test(expectedKey)
  return !isLetter || !event.shiftKey
}

function matchesContext(command: Command, context: 'list' | 'reader'): boolean {
  return command.context === 'global' || command.context === 'mail' || command.context === context
}

// Chord shortcuts are written with a space ("g i"): the prefix key opens a short
// window in which the next key completes the command. Prefixes are derived from
// the registry so registering a new chord needs no change to keyboard dispatch.
export function isChordPrefix(key: string, context: 'list' | 'reader'): boolean {
  const prefix = `${key.toLowerCase()} `
  return commands.some(
    (command) =>
      matchesContext(command, context) && (command.shortcut?.toLowerCase().startsWith(prefix) ?? false)
  )
}

export function chordKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  return event.key.toLowerCase()
}

export function findCommandByShortcut(shortcut: string, context: 'list' | 'reader'): Command | null {
  const normalized = shortcut.toLowerCase()
  return (
    commands.find(
      (command) => matchesContext(command, context) && command.shortcut?.toLowerCase() === normalized
    ) ?? null
  )
}

export function matchKey(event: KeyboardEvent, context: 'list' | 'reader'): Command | null {
  // Tab always belongs to native focus traversal. Shortcut-less commands remain
  // available to the future command palette without entering keyboard dispatch.
  if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Tab') return null
  return (
    commands.find(
      (command) =>
        matchesContext(command, context) &&
        command.shortcut !== undefined &&
        matchesShortcut(event, command.shortcut, context)
    ) ?? null
  )
}

/** Modifier dispatch stays scoped to the mounted composer so mail verbs cannot fire in text fields. */
export function matchComposerKey(event: KeyboardEvent): Command | null {
  if (event.altKey || event.key === 'Tab') return null
  const modifiers = [event.metaKey || event.ctrlKey ? 'mod' : '', event.shiftKey ? 'shift' : ''].filter(
    Boolean
  )
  const shortcut = [...modifiers, event.key.toLowerCase()].join('+')
  return (
    commands.find(
      (command) =>
        command.context === 'composer' && command.shortcut?.toLowerCase() === shortcut.toLowerCase()
    ) ?? null
  )
}

const ARROW_STEP = 120

// Reader scrolling is deliberately a local interaction primitive rather than a
// palette command. It changes viewport position, not application state.
export function readingScrollDelta(event: KeyboardEvent, viewportHeight: number): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  // A page keeps one line of overlap on short viewports, never less than one arrow step.
  const page = Math.max(ARROW_STEP, viewportHeight * 0.85)
  if (event.key === 'ArrowDown' && !event.shiftKey) return ARROW_STEP
  if (event.key === 'ArrowUp' && !event.shiftKey) return -ARROW_STEP
  if (event.key === 'PageDown' && !event.shiftKey) return page
  if (event.key === 'PageUp' && !event.shiftKey) return -page
  if (event.key === ' ' || event.code === 'Space') {
    return (event.shiftKey ? -1 : 1) * page
  }
  return null
}
