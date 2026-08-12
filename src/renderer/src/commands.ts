export type CommandContext = 'list' | 'reader' | 'mail' | 'global'

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
  'view.inbox': { title: 'Go to Inbox', shortcut: 'g i', context: 'global' },
  'view.snoozed': { title: 'Go to Snoozed', shortcut: 'g h', context: 'global' },
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
  if (context === 'list' && event.key === 'ArrowDown') return 'j'
  if (context === 'list' && event.key === 'ArrowUp') return 'k'
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

// Reader scrolling is deliberately a local interaction primitive rather than a
// palette command. It changes viewport position, not application state.
export function readingScrollDelta(event: KeyboardEvent, viewportHeight: number): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.key === 'ArrowDown' && !event.shiftKey) return 120
  if (event.key === 'ArrowUp' && !event.shiftKey) return -120
  if (event.key === 'PageDown' && !event.shiftKey) return Math.max(120, viewportHeight * 0.85)
  if (event.key === 'PageUp' && !event.shiftKey) return -Math.max(120, viewportHeight * 0.85)
  if (event.key === ' ' || event.code === 'Space') {
    return (event.shiftKey ? -1 : 1) * Math.max(120, viewportHeight * 0.85)
  }
  return null
}
