export type CommandContext = 'list' | 'reader' | 'outbox' | 'navigation' | 'mail' | 'composer' | 'global'
export type ShortcutContext = 'list' | 'reader' | 'outbox'
export type ActiveCommandContext = ShortcutContext | 'composer'

interface CommandSpec {
  title: string
  shortcut?: string
  shortcutAliases?: readonly string[]
  context: CommandContext
  allowInComposer?: boolean
}

export const COMMAND_SPECS = {
  'palette.open': {
    title: 'Open command palette',
    shortcut: 'Mod+K',
    context: 'global',
    allowInComposer: true
  },
  'navigate.next': { title: 'Next item', shortcut: 'j', context: 'navigation' },
  'navigate.previous': { title: 'Previous item', shortcut: 'k', context: 'navigation' },
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
  'message.next': { title: 'Next message in conversation', shortcut: 'n', context: 'reader' },
  'message.previous': { title: 'Previous message in conversation', shortcut: 'p', context: 'reader' },
  'message.toggle': { title: 'Expand or collapse message', shortcut: 'o', context: 'reader' },
  'message.trim.toggle': { title: 'Show or hide trimmed message content', context: 'reader' },
  'sync.retry': { title: 'Retry mail sync', context: 'global', allowInComposer: true },
  'sync.error.copy': {
    title: 'Copy sync error details',
    context: 'global',
    allowInComposer: true
  },
  'search.open': { title: 'Search mail', shortcut: '/', context: 'global' },
  'search.focusQuery': {
    title: 'Edit search query',
    shortcut: 'Backspace',
    context: 'list'
  },
  'search.allGmail': { title: 'Search all of Gmail', context: 'global' },
  'search.clear': { title: 'Clear search', context: 'global' },
  'split.previous': {
    title: 'Previous inbox split',
    shortcut: 'Shift+Tab',
    shortcutAliases: ['ArrowLeft'],
    context: 'list'
  },
  'split.next': {
    title: 'Next inbox split',
    shortcut: 'Tab',
    shortcutAliases: ['ArrowRight'],
    context: 'list'
  },
  'split.manage': { title: 'Manage inbox splits', context: 'global' },
  'theme.system': { title: 'Use System theme', context: 'global', allowInComposer: true },
  'theme.dispatch-dark': {
    title: 'Use Dark theme',
    context: 'global',
    allowInComposer: true
  },
  'theme.dispatch-light': {
    title: 'Use Light theme',
    context: 'global',
    allowInComposer: true
  },
  'theme.midnight': { title: 'Use Midnight theme', context: 'global', allowInComposer: true },
  'theme.sand': { title: 'Use Sand theme', context: 'global', allowInComposer: true },
  'view.inbox': {
    title: 'Go to Inbox',
    shortcut: 'g i',
    context: 'global',
    allowInComposer: true
  },
  'view.allMail': {
    title: 'Go to All Mail',
    shortcut: 'g a',
    context: 'global',
    allowInComposer: true
  },
  'view.sent': {
    title: 'Go to Sent',
    shortcut: 'g t',
    context: 'global',
    allowInComposer: true
  },
  'view.starred': {
    title: 'Go to Starred',
    shortcut: 'g s',
    context: 'global',
    allowInComposer: true
  },
  'view.snoozed': {
    title: 'Go to Snoozed',
    shortcut: 'g h',
    context: 'global',
    allowInComposer: true
  },
  'view.drafts': {
    title: 'Go to Drafts',
    shortcut: 'g d',
    context: 'global',
    allowInComposer: true
  },
  'view.spam': {
    title: 'Go to Spam',
    shortcut: 'g p',
    context: 'global',
    allowInComposer: true
  },
  'view.trash': {
    title: 'Go to Trash',
    shortcut: 'g r',
    context: 'global',
    allowInComposer: true
  },
  'view.outbox': {
    title: 'Go to Outbox',
    shortcut: 'g o',
    context: 'global',
    allowInComposer: true
  },
  'layout.sidebar.toggle': {
    title: 'Toggle sidebar',
    shortcut: 'Mod+B',
    context: 'global',
    allowInComposer: true
  },
  'outbox.open': { title: 'Open Outbox message', shortcut: 'Enter', context: 'outbox' },
  'outbox.close': { title: 'Back from Outbox', shortcut: 'Escape', context: 'outbox' },
  'draft.discard': { title: 'Discard draft', shortcut: 'Mod+Shift+D', context: 'list' },
  'composer.new': { title: 'New message', shortcut: 'c', context: 'global' },
  'composer.reply': { title: 'Reply', shortcut: 'r', context: 'reader' },
  'composer.replyAll': {
    title: 'Reply all',
    shortcut: 'a',
    shortcutAliases: ['Enter'],
    context: 'reader'
  },
  'composer.forward': { title: 'Forward', shortcut: 'f', context: 'reader' },
  'composer.close': { title: 'Save and close draft', shortcut: 'Escape', context: 'composer' },
  'composer.discard': { title: 'Discard draft', shortcut: 'Mod+Shift+D', context: 'composer' },
  'composer.send': { title: 'Send message', shortcut: 'Mod+Enter', context: 'composer' },
  'composer.attach': { title: 'Attach files', context: 'composer' },
  'composer.removeAttachment': { title: 'Remove last attachment', context: 'composer' },
  'composer.bold': { title: 'Bold', shortcut: 'Mod+B', context: 'composer' },
  'composer.italic': { title: 'Italic', shortcut: 'Mod+I', context: 'composer' },
  'composer.underline': { title: 'Underline', shortcut: 'Mod+U', context: 'composer' },
  'composer.strikethrough': { title: 'Strikethrough', context: 'composer' },
  'composer.fontFamily': { title: 'Set font family', context: 'composer' },
  'composer.fontSize': { title: 'Set font size', context: 'composer' },
  'composer.textColor': { title: 'Set text colour', context: 'composer' },
  'composer.backgroundColor': { title: 'Set text background colour', context: 'composer' },
  'composer.alignLeft': { title: 'Align left', context: 'composer' },
  'composer.alignCenter': { title: 'Align center', context: 'composer' },
  'composer.alignRight': { title: 'Align right', context: 'composer' },
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

export type StaticCommandId = keyof typeof COMMAND_SPECS
export type CommandId = StaticCommandId | `split.goto:${string}`

export interface CommandArgumentValue {
  label: string
  value: unknown
}

export interface CommandArgument {
  prefixes: readonly string[]
  parse: (input: string) => CommandArgumentValue | null
  run: (value: unknown) => void
}

export interface Command extends CommandSpec {
  id: CommandId
  run: () => void
  argument?: CommandArgument
}

const commands: Command[] = []
const commandRegistryListeners = new Set<() => void>()
let commandRegistrySnapshot: readonly Command[] = []

function notifyCommandRegistry(): void {
  commandRegistrySnapshot = [...commands]
  for (const listener of commandRegistryListeners) listener()
}

export function subscribeCommandRegistry(listener: () => void): () => void {
  commandRegistryListeners.add(listener)
  return () => commandRegistryListeners.delete(listener)
}

export function getCommandRegistrySnapshot(): readonly Command[] {
  return commandRegistrySnapshot
}

export function createCommand(
  id: StaticCommandId,
  run: () => void,
  overrides: Partial<Pick<Command, 'title' | 'shortcut' | 'shortcutAliases' | 'context' | 'argument'>> = {}
): Command {
  return { id, ...COMMAND_SPECS[id], ...overrides, run }
}

export function createDynamicSplitCommand(
  splitId: string,
  title: string,
  run: () => void,
  shortcut?: string
): Command {
  return {
    id: `split.goto:${splitId}`,
    title,
    ...(shortcut ? { shortcut } : {}),
    context: 'navigation',
    run
  }
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
  notifyCommandRegistry()
  return () => {
    let changed = false
    for (const command of next) {
      const index = commands.indexOf(command)
      if (index >= 0) {
        commands.splice(index, 1)
        changed = true
      }
    }
    if (changed) notifyCommandRegistry()
  }
}

export function listCommands(): readonly Command[] {
  return commandRegistrySnapshot
}

function normalizedKey(event: KeyboardEvent, context: ShortcutContext): string {
  // Arrows alias to J/K so navigation and range selection accept either. A bare
  // arrow in the reader scrolls instead — readingScrollDelta claims it before
  // dispatch reaches here — but Shift+Arrow keeps extending the selection in
  // both contexts rather than becoming a dead key while reading.
  const aliasesArrows = context === 'list' || context === 'outbox' || event.shiftKey
  if (aliasesArrows && event.key === 'ArrowDown') return 'j'
  if (aliasesArrows && event.key === 'ArrowUp') return 'k'
  return event.key.toLowerCase()
}

function matchesShortcut(event: KeyboardEvent, shortcut: string, context: ShortcutContext): boolean {
  if (shortcut.includes(' ')) return false
  const parts = shortcut.toLowerCase().split('+')
  const expectedKey = parts.at(-1)
  const expectsMod = parts.includes('mod')
  const expectsShift = parts.includes('shift')
  if (!expectedKey || expectsMod !== (event.metaKey || event.ctrlKey) || event.altKey) return false
  if (expectedKey !== normalizedKey(event, context)) return false
  if (expectsShift) return event.shiftKey
  if (expectedKey === 'tab' && event.shiftKey) return false

  // Shift is part of the keystroke for printable symbols such as # and !, but it
  // distinguishes J/K navigation from Shift+J/K range selection. Bare-letter
  // shortcuts deliberately decline Shift so that namespace stays reserved for
  // future combinations without changing muscle memory later.
  const isLetter = /^[a-z]$/.test(expectedKey)
  return !isLetter || !event.shiftKey
}

export function commandMatchesContext(
  command: Pick<Command, 'context' | 'allowInComposer'>,
  context: ActiveCommandContext
): boolean {
  if (context === 'composer') {
    return (
      command.context === 'composer' || (command.context === 'global' && command.allowInComposer === true)
    )
  }
  return (
    command.context === 'global' ||
    command.context === 'navigation' ||
    (command.context === 'mail' && context !== 'outbox') ||
    command.context === context
  )
}

function commandShortcuts(command: Command): readonly string[] {
  return [...(command.shortcut ? [command.shortcut] : []), ...(command.shortcutAliases ?? [])]
}

// Chord shortcuts are written with a space ("g i"): the prefix key opens a short
// window in which the next key completes the command. Prefixes are derived from
// the registry so registering a new chord needs no change to keyboard dispatch.
export function isChordPrefix(key: string, context: ShortcutContext): boolean {
  const prefix = `${key.toLowerCase()} `
  return commands.some(
    (command) =>
      commandMatchesContext(command, context) &&
      commandShortcuts(command).some((shortcut) => shortcut.toLowerCase().startsWith(prefix))
  )
}

export function chordKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  return event.key.toLowerCase()
}

export function findCommandByShortcut(shortcut: string, context: ShortcutContext): Command | null {
  const normalized = shortcut.toLowerCase()
  return (
    commands.find(
      (command) =>
        commandMatchesContext(command, context) &&
        commandShortcuts(command).some((candidate) => candidate.toLowerCase() === normalized)
    ) ?? null
  )
}

export function matchKey(event: KeyboardEvent, context: ShortcutContext): Command | null {
  // The dispatcher preserves native Tab inside interactive controls and text
  // entry. A registered list command can therefore use it from the mail canvas.
  if (event.altKey) return null
  return (
    commands.find(
      (command) =>
        commandMatchesContext(command, context) &&
        commandShortcuts(command).some((shortcut) => matchesShortcut(event, shortcut, context))
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
        command.context === 'composer' &&
        commandShortcuts(command).some((candidate) => candidate.toLowerCase() === shortcut.toLowerCase())
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
