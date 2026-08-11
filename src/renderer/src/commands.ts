export type CommandContext = 'list' | 'global'

export interface Command {
  id: string
  title: string
  shortcut: string
  context: CommandContext
  run: () => void
}

const commands: Command[] = []

export function registerCommands(next: Command[]): () => void {
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

function normalizedKey(event: KeyboardEvent): string {
  if (event.key === 'ArrowDown') return 'j'
  if (event.key === 'ArrowUp') return 'k'
  return event.key.toLowerCase()
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const normalizedShortcut = shortcut.toLowerCase()
  const expectsShift = normalizedShortcut.startsWith('shift+')
  const expectedKey = expectsShift ? normalizedShortcut.slice('shift+'.length) : normalizedShortcut
  if (expectedKey !== normalizedKey(event)) return false
  if (expectsShift) return event.shiftKey

  // Shift is part of the keystroke for printable symbols such as # and !, but
  // it must distinguish J/K navigation from Shift+J/K range selection.
  const isLetter = /^[a-z]$/.test(expectedKey)
  return !isLetter || !event.shiftKey
}

export function matchKey(event: KeyboardEvent, context: Exclude<CommandContext, 'global'>): Command | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  return (
    commands.find(
      (command) =>
        (command.context === context || command.context === 'global') &&
        matchesShortcut(event, command.shortcut)
    ) ?? null
  )
}
