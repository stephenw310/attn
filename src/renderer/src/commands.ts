export type CommandContext = 'list' | 'overlay' | 'global'

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

export function matchKey(event: KeyboardEvent, context: Exclude<CommandContext, 'global'>): Command | null {
  const key = normalizedKey(event)
  return (
    commands.find(
      (command) =>
        (command.context === context || command.context === 'global') &&
        command.shortcut.toLowerCase() === key
    ) ?? null
  )
}
