import { useSyncExternalStore } from 'react'
import {
  type FooterContext,
  getCommandRegistrySnapshot,
  listChordCompletions,
  listFooterHints,
  subscribeCommandRegistry
} from '../commands'
import { formatShortcutKey } from '../platform'
import { Kbd } from './Kbd'

function Shortcut({ shortcut }: { shortcut: string }): React.JSX.Element {
  return <Kbd>{shortcut.split('+').map(formatShortcutKey).join(' ')}</Kbd>
}

function FooterShortcut({
  id,
  shortcuts,
  label
}: {
  id: string
  shortcuts: readonly string[]
  label: string
}): React.JSX.Element {
  return (
    <span
      data-testid={`footer-shortcut-${id}`}
      className="flex flex-none items-center gap-1.5 whitespace-nowrap text-ink-dim"
    >
      <span className="flex items-center gap-1.5">
        {shortcuts.map((shortcut) => (
          <span key={shortcut} className="contents">
            <Shortcut shortcut={shortcut} />
          </span>
        ))}
      </span>
      {label}
    </span>
  )
}

function ChordGuide({ prefix, context }: { prefix: string; context: FooterContext }): React.JSX.Element {
  const shortcutContext = context === 'reader' || context === 'outbox' ? context : 'list'
  const completions = listChordCompletions(prefix, shortcutContext)
  return (
    <div
      data-testid="footer-chord-guide"
      data-prefix={prefix}
      className="flex flex-none items-center gap-2 whitespace-nowrap text-[11px]"
      aria-live="polite"
    >
      <span className="sr-only">Go to</span>
      {completions.map((completion) => (
        <span
          key={`${completion.commandId}:${completion.key}`}
          data-testid={`footer-chord-${completion.key}`}
          className="flex items-center gap-1 text-ink-dim"
        >
          <Kbd compact>{formatShortcutKey(completion.key)}</Kbd>
          {completion.label}
        </span>
      ))}
    </div>
  )
}

interface MailFooterProps {
  onOpenShortcuts?: () => void
  context: FooterContext
  pendingChord: string | null
}

export function MailFooter(props: MailFooterProps): React.JSX.Element {
  const { context, pendingChord } = props
  useSyncExternalStore(subscribeCommandRegistry, getCommandRegistrySnapshot)
  const hints = listFooterHints(context).filter((hint) =>
    context === 'reader'
      ? ['message-navigation', 'message-toggle', 'reply'].includes(hint.id)
      : !(context === 'composer' && hint.id === 'back')
  )
  return (
    <footer
      id="mail-footer"
      data-testid="mail-footer"
      className="relative z-40 flex min-h-11 flex-none items-center gap-4 bg-ground px-6 py-1.5 text-[11px] text-ink-dim"
    >
      <div
        key={`${context}:${pendingChord ?? 'default'}`}
        data-testid="footer-shortcuts"
        className="flex min-w-0 flex-1 items-center gap-x-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pendingChord ? (
          <ChordGuide prefix={pendingChord} context={context} />
        ) : (
          hints.map((hint) => <FooterShortcut key={hint.id} {...hint} />)
        )}
      </div>
      {!pendingChord && (
        <button
          type="button"
          onClick={props.onOpenShortcuts}
          className="flex flex-none cursor-pointer items-center gap-1.5 text-[11px] text-ink-dim hover:text-ink"
          data-testid="footer-all-shortcuts"
        >
          All shortcuts <Shortcut shortcut="Mod+/" />
        </button>
      )}
    </footer>
  )
}
