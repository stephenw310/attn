import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { CommandUsage } from '../../../shared/commandUsage'
import { type PaletteResult, rankCommands, recordCommandUse } from '../commandPalette'
import {
  type ActiveCommandContext,
  createCommand,
  getCommandRegistrySnapshot,
  registerCommands,
  subscribeCommandRegistry
} from '../commands'
import { modKeyLabel } from '../platform'
import { Kbd } from './Kbd'

interface CommandPaletteProps {
  account: string | null
  context: ActiveCommandContext
}

interface ReturnFocus {
  element: HTMLElement
  range: Range | null
}

function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLocaleLowerCase() === 'k' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function shortcutLabel(shortcut: string): string {
  return shortcut
    .replace(/Mod/gi, modKeyLabel())
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((key) => (/^[a-z]$/i.test(key) ? key.toLocaleUpperCase() : key))
        .join('+')
    )
    .join(' ')
}

export function CommandPalette({ account, context }: CommandPaletteProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [usage, setUsage] = useState<CommandUsage>({})
  const [usageLoaded, setUsageLoaded] = useState(false)
  const usageRef = useRef(usage)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const paletteRef = useRef<HTMLElement | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<ReturnFocus | null>(null)
  const registeredCommands = useSyncExternalStore(
    subscribeCommandRegistry,
    getCommandRegistrySnapshot,
    getCommandRegistrySnapshot
  )

  const openPalette = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && !paletteRef.current?.contains(activeElement)) {
      const selection = window.getSelection()
      const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null
      returnFocusRef.current = {
        element: activeElement,
        range:
          selectedRange && activeElement.contains(selectedRange.commonAncestorContainer)
            ? selectedRange.cloneRange()
            : null
      }
    }
    setQuery('')
    setActiveIndex(0)
    setOpen(true)
  }, [])
  const closePalette = useCallback(() => {
    setOpen(false)
    const returnFocus = returnFocusRef.current
    returnFocusRef.current = null
    if (!returnFocus?.element.isConnected) return
    returnFocus.element.focus({ preventScroll: true })
    if (returnFocus.range?.startContainer.isConnected && returnFocus.range.endContainer.isConnected) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(returnFocus.range)
    }
  }, [])

  useLayoutEffect(() => registerCommands([createCommand('palette.open', openPalette)]), [openPalette])

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPaletteShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
      openPalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openPalette])

  useLayoutEffect(() => {
    if (!open) return
    const containKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePalette()
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        inputRef.current?.focus({ preventScroll: true })
        return
      }
      const target = event.target instanceof Node ? event.target : null
      if (target && paletteRef.current?.contains(target)) return
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', containKey, true)
    return () => window.removeEventListener('keydown', containKey, true)
  }, [closePalette, open])

  useEffect(() => {
    usageRef.current = {}
    setUsage({})
    setUsageLoaded(false)
    if (!account) {
      setUsageLoaded(true)
      return
    }
    let active = true
    window.attn?.settings
      .getCommandUsage(account)
      .then((stored) => {
        if (!active) return
        usageRef.current = stored
        setUsage(stored)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setUsageLoaded(true)
      })
    return () => {
      active = false
    }
  }, [account])

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true })
  }, [open])

  const results = useMemo(
    () => (open ? rankCommands(registeredCommands, context, query, usage) : []),
    [context, open, query, registeredCommands, usage]
  )

  useEffect(() => {
    setActiveIndex((current) => Math.max(0, Math.min(current, results.length - 1)))
  }, [results.length])

  const activeResult = results[activeIndex]
  useLayoutEffect(() => {
    if (!activeResult) return
    const activeOption = resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    activeOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeResult])

  const runResult = useCallback(
    (result: PaletteResult) => {
      if (usageLoaded && account) {
        const nextUsage = recordCommandUse(usageRef.current, result.command.id)
        usageRef.current = nextUsage
        setUsage(nextUsage)
        void window.attn?.settings.setCommandUsage(account, nextUsage).catch(() => {})
      }
      closePalette()
      if (result.argument && result.command.argument) {
        result.command.argument.run(result.argument.value)
      } else result.command.run()
    },
    [account, closePalette, usageLoaded]
  )

  if (!open) return null

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the dialog input */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is the pointer dismissal path */}
      <div
        data-testid="command-palette-backdrop"
        className="fixed inset-0 z-[80] bg-overlay"
        onClick={closePalette}
      />
      <section
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        data-usage-loaded={usageLoaded ? 'true' : 'false'}
        className="fixed top-[15vh] left-1/2 z-[90] flex max-h-[70vh] w-[min(640px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-dialog"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-ink-faint">
            <circle cx="10.5" cy="10.5" r="6.5" strokeWidth="1.8" />
            <path d="m15.5 15.5 4 4" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={activeResult ? `command-palette-${activeResult.command.id}` : undefined}
            aria-autocomplete="list"
            placeholder="Type a command"
            className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                if (results.length === 0) return
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setActiveIndex((current) => (current + direction + results.length) % results.length)
                return
              }
              if (event.key === 'Enter' && activeResult) {
                event.preventDefault()
                event.stopPropagation()
                runResult(activeResult)
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          ref={resultsRef}
          id="command-palette-results"
          role="listbox"
          data-testid="command-palette-results"
          data-palette-query={query}
          className="min-h-0 overflow-y-auto p-2"
        >
          {results.length === 0 ? (
            <p data-testid="command-palette-empty" className="px-3 py-8 text-center text-sm text-ink-faint">
              No commands found
            </p>
          ) : (
            results.map((result, index) => (
              <button
                key={result.command.id}
                id={`command-palette-${result.command.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                data-testid="command-palette-result"
                data-command-id={result.command.id}
                data-active={index === activeIndex || undefined}
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${
                  index === activeIndex
                    ? 'bg-active text-ink'
                    : 'text-ink-dim hover:bg-active/60 hover:text-ink'
                }`}
                onMouseMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runResult(result)}
              >
                <span className="min-w-0 flex-1 truncate">{result.title}</span>
                {result.command.shortcut && <Kbd>{shortcutLabel(result.command.shortcut)}</Kbd>}
              </button>
            ))
          )}
        </div>
      </section>
    </>
  )
}
