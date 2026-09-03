import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  COMMAND_CONTEXT_GROUPS,
  type Command,
  getCommandRegistrySnapshot,
  subscribeCommandRegistry
} from '../commands'
import { shortcutLabel } from './CommandPalette'
import { Kbd } from './Kbd'

interface CheatSheetProps {
  open: boolean
  /** The palette renders above the sheet and owns input while it is up. */
  paletteOpen: boolean
  onOpen: () => void
  onClose: () => void
}

interface SheetGroup {
  label: string
  commands: Command[]
}

function isCheatSheetShortcut(event: KeyboardEvent): boolean {
  return event.key === '/' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
}

/**
 * Group every currently registered command that carries a shortcut (F15). The
 * sheet renders from the registry, never from a hardcoded table, so a new
 * command with a shortcut appears without editing it. Chord shortcuts
 * ("g i") come through the same path as modifier shortcuts.
 */
function sheetGroups(commands: readonly Command[]): SheetGroup[] {
  const labelByContext = new Map(COMMAND_CONTEXT_GROUPS.map((group) => [group.context, group.label]))
  const groups = new Map<string, Command[]>()
  for (const { label } of COMMAND_CONTEXT_GROUPS) {
    if (!groups.has(label)) groups.set(label, [])
  }
  for (const command of commands) {
    if (!command.shortcut) continue
    const label = labelByContext.get(command.context)
    if (!label) continue
    groups.get(label)?.push(command)
  }
  return [...groups.entries()]
    .map(([label, grouped]) => ({
      label,
      commands: grouped.sort((left, right) => left.title.localeCompare(right.title))
    }))
    .filter((group) => group.commands.length > 0)
}

export function CheatSheet({
  open,
  paletteOpen,
  onOpen,
  onClose
}: CheatSheetProps): React.JSX.Element | null {
  const registeredCommands = useSyncExternalStore(
    subscribeCommandRegistry,
    getCommandRegistrySnapshot,
    getCommandRegistrySnapshot
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isCheatSheetShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (open) onClose()
        else onOpen()
        return
      }
      if (!open) return
      // The palette can sit above the sheet; while it is up, input is its.
      if (paletteOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      // The sheet is modal: nothing else may reach the surfaces underneath —
      // a covered composer must not receive Mod+Enter (PR #101 review).
      // Default behavior stays, so scroll keys still move the focused sheet;
      // only Tab is fully spent, or focus would walk out of the dialog.
      if (event.key === 'Tab') event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, onOpen, open, paletteOpen])

  // Modal focus: the sheet's scroll region takes focus while open — that is
  // what makes arrow/page keys scroll it and keeps typing out of whatever the
  // sheet covers — and the opener's focus comes back on close.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    returnFocusRef.current = previous instanceof HTMLElement ? previous : null
    scrollRef.current?.focus({ preventScroll: true })
    return () => {
      const returnFocus = returnFocusRef.current
      returnFocusRef.current = null
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [open])

  const groups = useMemo(() => (open ? sheetGroups(registeredCommands) : []), [open, registeredCommands])

  if (!open) return null

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the window capture above */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is the pointer dismissal path */}
      <div data-testid="cheat-sheet-backdrop" className="fixed inset-0 z-[80] bg-overlay" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="cheat-sheet"
        className="fixed top-1/2 left-1/2 z-[90] flex max-h-[84vh] w-[min(880px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-dialog"
      >
        <div className="flex flex-none items-center gap-3 border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">Keyboard shortcuts</h2>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
            <Kbd>Esc</Kbd> closes
          </span>
        </div>
        <div ref={scrollRef} tabIndex={-1} className="min-h-0 overflow-y-auto px-5 py-4 outline-none">
          <div className="columns-1 gap-8 sm:columns-2 lg:columns-3">
            {groups.map((group) => (
              <div key={group.label} data-testid="cheat-sheet-group" className="mb-6 break-inside-avoid">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {group.label}
                </h3>
                <ul className="mt-2 flex flex-col gap-1">
                  {group.commands.map((command) => (
                    <li
                      key={command.id}
                      data-testid="cheat-sheet-command"
                      data-command-id={command.id}
                      className="flex items-center justify-between gap-3 text-[13px] text-ink-dim"
                    >
                      <span className="min-w-0 truncate">{command.title}</span>
                      {command.shortcut && <Kbd>{shortcutLabel(command.shortcut)}</Kbd>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p data-testid="cheat-sheet-autocomplete-note" className="mt-2 text-[11px] text-ink-faint">
            With inline AI autocomplete enabled, <Kbd>Tab</Kbd> accepts a visible suggestion in the composer
            body and <Kbd>Esc</Kbd> dismisses it; without one, both keys keep their normal behavior.
          </p>
        </div>
      </section>
    </>
  )
}
