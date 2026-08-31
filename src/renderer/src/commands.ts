export type CommandContext = 'list' | 'reader' | 'outbox' | 'navigation' | 'mail' | 'composer' | 'global'
export type ShortcutContext = 'list' | 'reader' | 'outbox'
export type ActiveCommandContext = ShortcutContext | 'composer'
export type FooterContext = ActiveCommandContext | 'search'

interface FooterHintSpec {
  id: string
  label: string
  order: number
  shortcuts?: readonly string[]
}

interface ChordGuideSpec {
  label: string
  order: number
}

interface CommandSpec {
  title: string
  shortcut?: string
  shortcutAliases?: readonly string[]
  context: CommandContext
  allowInComposer?: boolean
  footer?: Partial<Record<FooterContext, FooterHintSpec>>
  chordGuide?: ChordGuideSpec
}

export const COMMAND_SPECS = {
  'palette.open': {
    title: 'Open command palette',
    shortcut: 'Mod+K',
    context: 'global',
    allowInComposer: true,
    footer: { list: { id: 'palette', label: 'command palette', order: 80 } }
  },
  'navigate.next': {
    title: 'Next item',
    shortcut: 'j',
    context: 'navigation',
    footer: {
      list: { id: 'navigate', label: 'navigate', order: 10 },
      reader: { id: 'navigate', label: 'next / previous', order: 50 },
      outbox: { id: 'navigate', label: 'navigate', order: 10 }
    }
  },
  'navigate.previous': {
    title: 'Previous item',
    shortcut: 'k',
    context: 'navigation',
    footer: {
      list: { id: 'navigate', label: 'navigate', order: 10 },
      reader: { id: 'navigate', label: 'next / previous', order: 50 },
      outbox: { id: 'navigate', label: 'navigate', order: 10 }
    }
  },
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
  'conversation.open': {
    title: 'Open conversation',
    shortcut: 'Enter',
    context: 'list',
    footer: { list: { id: 'open', label: 'open', order: 20 } }
  },
  'conversation.close': {
    title: 'Back to conversation list',
    shortcut: 'Escape',
    context: 'reader',
    footer: { reader: { id: 'back', label: 'back to list', order: 60 } }
  },
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
  'search.submit': {
    title: 'Browse search results',
    context: 'list',
    footer: {
      search: { id: 'search-browse', label: 'search', order: 10, shortcuts: ['Enter'] }
    }
  },
  'search.clear': {
    title: 'Clear search',
    context: 'global',
    footer: {
      search: { id: 'search-close', label: 'close search', order: 20, shortcuts: ['Escape'] }
    }
  },
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
  'account.add': { title: 'Add account…', context: 'global' },
  'account.remove': { title: 'Sign out', context: 'global' },
  'settings.open': { title: 'Open settings', shortcut: 'Mod+,', context: 'global' },
  'settings.reorderAccounts': { title: 'Reorder accounts…', context: 'global' },
  'settings.syncLimit': { title: 'Set historical sync limit…', context: 'global' },
  'compose.attnFooter.enable': { title: 'Enable "Sent with Attn" footer', context: 'global' },
  'compose.attnFooter.disable': { title: 'Disable "Sent with Attn" footer', context: 'global' },
  'privacy.remoteImages.block': { title: 'Block remote images', context: 'global' },
  'privacy.remoteImages.load': { title: 'Load remote images', context: 'global' },
  'privacy.remoteImages.overrides': { title: 'Manage remote-image overrides…', context: 'global' },
  'snippets.manage': { title: 'Manage snippets…', context: 'global' },
  'ai.settings': { title: 'Set up AI writing…', context: 'global' },
  // T37A: enabling routes through the settings consent flow (the disclosure
  // must precede the traffic); disabling is immediate.
  'autocomplete.enable': { title: 'Enable inline AI autocomplete…', context: 'global' },
  'autocomplete.disable': { title: 'Disable inline AI autocomplete', context: 'global' },
  'settings.undoSendDelay': { title: 'Set undo send delay…', context: 'global' },
  'settings.autoAdvance': { title: 'Set auto-advance…', context: 'global' },
  'settings.launchAtLogin': { title: 'Toggle launch at login', context: 'global' },
  'settings.menuBarIcon': { title: 'Toggle macOS menu-bar icon', context: 'global' },
  'notifications.pauseHour': {
    title: 'Pause notifications for 1 hour',
    context: 'global',
    allowInComposer: true
  },
  'notifications.pauseTomorrow': {
    title: 'Pause notifications until tomorrow',
    context: 'global',
    allowInComposer: true
  },
  'notifications.resume': { title: 'Resume notifications', context: 'global', allowInComposer: true },
  'cheatsheet.open': {
    title: 'Keyboard shortcuts',
    shortcut: 'Mod+/',
    context: 'global',
    allowInComposer: true
  },
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
    allowInComposer: true,
    chordGuide: { label: 'Inbox', order: 10 }
  },
  'view.allMail': {
    title: 'Go to All Mail',
    shortcut: 'g a',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'All Mail', order: 20 }
  },
  'view.sent': {
    title: 'Go to Sent',
    shortcut: 'g t',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Sent', order: 30 }
  },
  'view.starred': {
    title: 'Go to Starred',
    shortcut: 'g s',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Starred', order: 50 }
  },
  'view.snoozed': {
    title: 'Go to Snoozed',
    shortcut: 'g h',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Snoozed', order: 60 }
  },
  'view.drafts': {
    title: 'Go to Drafts',
    shortcut: 'g d',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Drafts', order: 40 }
  },
  'view.spam': {
    title: 'Go to Spam',
    shortcut: 'g p',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Spam', order: 70 }
  },
  'view.trash': {
    title: 'Go to Trash',
    shortcut: 'g r',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Trash', order: 80 }
  },
  'view.outbox': {
    title: 'Go to Outbox',
    shortcut: 'g o',
    context: 'global',
    allowInComposer: true,
    chordGuide: { label: 'Outbox', order: 90 }
  },
  'layout.sidebar.toggle': {
    title: 'Toggle sidebar',
    shortcut: 'Mod+B',
    context: 'global',
    allowInComposer: true
  },
  'outbox.open': {
    title: 'Open Outbox message',
    shortcut: 'Enter',
    context: 'outbox',
    footer: { outbox: { id: 'open', label: 'open', order: 20 } }
  },
  'outbox.close': {
    title: 'Back from Outbox',
    shortcut: 'Escape',
    context: 'outbox',
    footer: { outbox: { id: 'back', label: 'back', order: 30 } }
  },
  'draft.discard': {
    title: 'Discard draft',
    shortcut: 'Mod+Shift+D',
    context: 'list',
    footer: { list: { id: 'delete-draft', label: 'delete draft', order: 30 } }
  },
  'composer.new': {
    title: 'New message',
    shortcut: 'c',
    context: 'global',
    footer: { list: { id: 'compose', label: 'compose', order: 40 } }
  },
  'composer.reply': {
    title: 'Reply',
    shortcut: 'r',
    context: 'reader',
    footer: { reader: { id: 'reply', label: 'reply', order: 10 } }
  },
  'composer.replyAll': {
    title: 'Reply all',
    shortcut: 'a',
    shortcutAliases: ['Enter'],
    context: 'reader',
    footer: { reader: { id: 'reply-all', label: 'reply all', order: 11, shortcuts: ['a'] } }
  },
  'composer.forward': {
    title: 'Forward',
    shortcut: 'f',
    context: 'reader',
    footer: { reader: { id: 'forward', label: 'forward', order: 12 } }
  },
  'composer.close': {
    title: 'Save and close draft',
    shortcut: 'Escape',
    context: 'composer',
    footer: { composer: { id: 'back', label: 'save and close', order: 20 } }
  },
  'composer.discard': { title: 'Discard draft', shortcut: 'Mod+Shift+D', context: 'composer' },
  'composer.send': {
    title: 'Send message',
    shortcut: 'Mod+Enter',
    context: 'composer',
    footer: { composer: { id: 'send', label: 'send', order: 10 } }
  },
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
  // F17: works from the reader (opening the inline reply first) and inside a
  // reply/reply-all composer; elsewhere the single Inbox-owned handler explains
  // itself with a hint instead of registering per-context duplicates.
  'composer.aiDraft': {
    title: 'Draft AI reply',
    shortcut: 'Mod+J',
    context: 'global',
    allowInComposer: true
  },
  'composer.snippets': { title: 'Insert snippet…', shortcut: 'Mod+;', context: 'composer' },
  'composer.followUp': { title: 'Remind me if no reply…', context: 'composer' },
  'triage.archive': {
    title: 'Mark done',
    shortcut: 'e',
    context: 'mail',
    footer: {
      list: { id: 'done', label: 'done', order: 30 },
      reader: { id: 'done', label: 'done', order: 20 }
    }
  },
  'triage.notDone': { title: 'Mark not done', shortcut: 'Shift+E', context: 'mail' },
  'triage.snooze': {
    title: 'Snooze / remind me later',
    shortcut: 'h',
    context: 'mail',
    footer: {
      list: { id: 'snooze', label: 'snooze', order: 60 },
      reader: { id: 'snooze', label: 'snooze', order: 30 }
    }
  },
  'triage.trash': { title: 'Move to trash', shortcut: '#', context: 'mail' },
  'triage.spam': { title: 'Mark as spam', shortcut: '!', context: 'mail' },
  'triage.star': { title: 'Star', shortcut: 's', context: 'mail' },
  'triage.unread': { title: 'Mark unread', shortcut: 'u', context: 'mail' },
  'triage.move': {
    title: 'Move',
    shortcut: 'v',
    context: 'mail',
    footer: {
      list: { id: 'move', label: 'move', order: 70 },
      reader: { id: 'move', label: 'move', order: 40 }
    }
  },
  'triage.label': { title: 'Label', shortcut: 'l', context: 'mail' },
  'triage.undo': {
    title: 'Undo',
    shortcut: 'z',
    context: 'global',
    footer: {
      list: { id: 'undo', label: 'undo', order: 50 },
      outbox: { id: 'undo', label: 'undo', order: 40 }
    }
  }
} as const satisfies Record<string, CommandSpec>

export type StaticCommandId = keyof typeof COMMAND_SPECS
export type CommandId =
  | StaticCommandId
  | `split.goto:${string}`
  | `account.switch:${string}`
  | `snippet.insert:${string}`
  // The e2e-only registration seam (cheat-sheet coverage); see installTestSeam.
  | `test:${string}`

/**
 * How the cheat sheet groups the registry (F15): every command context maps to
 * one §5-style heading, so a new command appears on the sheet without editing
 * it. Order is the §5 reading order.
 */
export const COMMAND_CONTEXT_GROUPS: readonly { context: CommandContext; label: string }[] = [
  { context: 'global', label: 'Global' },
  { context: 'navigation', label: 'List & navigation' },
  { context: 'list', label: 'List & navigation' },
  { context: 'mail', label: 'Triage' },
  { context: 'reader', label: 'Conversation' },
  { context: 'outbox', label: 'Outbox' },
  { context: 'composer', label: 'Composer' }
]

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

export function createDynamicSplitCommand(splitId: string, title: string, run: () => void): Command {
  return {
    id: `split.goto:${splitId}`,
    title,
    context: 'navigation',
    run
  }
}

/** Switch to a signed-in account (F18). `Mod+1..9` rides the switcher order. */
export function createAccountSwitchCommand(
  accountId: string,
  title: string,
  run: () => void,
  shortcut?: string
): Command {
  return {
    id: `account.switch:${accountId}`,
    title,
    ...(shortcut ? { shortcut } : {}),
    context: 'global',
    run
  }
}

/** Palette insertion for one snippet ("Snippet: intro", F8); composer-scoped. */
export function createSnippetInsertCommand(snippetId: string, name: string, run: () => void): Command {
  return {
    id: `snippet.insert:${snippetId}`,
    title: `Snippet: ${name}`,
    context: 'composer',
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

export interface FooterHint {
  id: string
  label: string
  order: number
  shortcuts: readonly string[]
}

export function listFooterHints(context: FooterContext): readonly FooterHint[] {
  const hints = new Map<string, FooterHint>()
  for (const command of commands) {
    const spec = command.footer?.[context]
    if (!spec || (context !== 'search' && !commandMatchesContext(command, context))) continue
    const shortcuts = spec.shortcuts ?? (command.shortcut ? [command.shortcut] : [])
    if (shortcuts.length === 0) continue
    const existing = hints.get(spec.id)
    if (existing) {
      hints.set(spec.id, {
        ...existing,
        shortcuts: [...existing.shortcuts, ...shortcuts.filter((item) => !existing.shortcuts.includes(item))]
      })
    } else {
      hints.set(spec.id, { id: spec.id, label: spec.label, order: spec.order, shortcuts })
    }
  }
  return [...hints.values()].sort((left, right) => left.order - right.order)
}

export interface ChordCompletion {
  commandId: CommandId
  key: string
  label: string
}

export function listChordCompletions(
  prefixKey: string,
  context: ShortcutContext
): readonly ChordCompletion[] {
  const prefix = `${prefixKey.toLowerCase()} `
  const completions: Array<ChordCompletion & { order: number }> = []
  for (const command of commands) {
    if (!commandMatchesContext(command, context)) continue
    for (const shortcut of commandShortcuts(command)) {
      const normalized = shortcut.toLowerCase()
      if (!normalized.startsWith(prefix)) continue
      const key = normalized.slice(prefix.length)
      if (!key || key.includes(' ')) continue
      completions.push({
        commandId: command.id,
        key,
        label: command.chordGuide?.label ?? command.title,
        order: command.chordGuide?.order ?? Number.MAX_SAFE_INTEGER
      })
    }
  }
  return completions
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map(({ order: _order, ...completion }) => completion)
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
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
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
  // The same context rule the palette applies: composer commands plus the
  // global allowInComposer set (Mod+J AI drafting, Mod+/ cheat sheet — Mod+K
  // never reaches here because the palette claims it in the capture phase).
  // Chord shortcuts contain a space and can never equal a single keystroke.
  return (
    commands.find(
      (command) =>
        commandMatchesContext(command, 'composer') &&
        commandShortcuts(command).some((candidate) => candidate.toLowerCase() === shortcut.toLowerCase())
    ) ?? null
  )
}

declare global {
  interface Window {
    /** E2e-only (ATTN_TEST_USER_DATA): lets a spec register a shortcut command
        and assert the cheat sheet picked it up from the registry. */
    attnTest?: {
      registerCommand: (id: string, title: string, shortcut?: string) => void
    }
  }
}

if (typeof window !== 'undefined' && window.attn?.testMode) {
  window.attnTest = {
    registerCommand: (id, title, shortcut) => {
      registerCommands([
        {
          id: `test:${id}`,
          title,
          ...(shortcut ? { shortcut } : {}),
          context: 'global',
          run: () => {}
        }
      ])
    }
  }
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
