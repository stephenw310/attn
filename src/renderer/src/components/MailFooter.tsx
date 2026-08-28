import { useSyncExternalStore } from 'react'
import type { SyncState } from '../../../shared/mail'
import {
  type FooterContext,
  getCommandRegistrySnapshot,
  listChordCompletions,
  listFooterHints,
  subscribeCommandRegistry
} from '../commands'
import { modKeyLabel } from '../platform'
import { Kbd } from './Kbd'
import { SyncStatus } from './SyncStatus'

function keyLabel(key: string): string {
  if (key.toLowerCase() === 'mod') return modKeyLabel()
  if (key.toLowerCase() === 'escape') return 'Esc'
  return key.length === 1 ? key.toUpperCase() : key
}

function Shortcut({ shortcut }: { shortcut: string }): React.JSX.Element {
  const parts = shortcut.split('+')
  return (
    <span className="flex items-center gap-0.5">
      {parts.map((part, index) => (
        <span key={part} className="contents">
          {index > 0 && <span aria-hidden>+</span>}
          <Kbd>{keyLabel(part)}</Kbd>
        </span>
      ))}
    </span>
  )
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
      <span className="flex items-center gap-0.5">
        {shortcuts.map((shortcut, index) => (
          <span key={shortcut} className="contents">
            {index > 0 && <span aria-hidden>/</span>}
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
      <span className="flex items-center gap-1 text-ink-faint">
        <Kbd compact>{keyLabel(prefix)}</Kbd>
        <span className="sr-only">then</span>
        <span aria-hidden>→</span>
      </span>
      {completions.map((completion) => (
        <span
          key={`${completion.commandId}:${completion.key}`}
          data-testid={`footer-chord-${completion.key}`}
          className="flex items-center gap-1 text-ink-dim"
        >
          <Kbd compact>{keyLabel(completion.key)}</Kbd>
          {completion.label}
        </span>
      ))}
    </div>
  )
}

interface MailFooterProps {
  context: FooterContext
  pendingChord: string | null
  sync: SyncState
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}

export function MailFooter(props: MailFooterProps): React.JSX.Element {
  const { context, pendingChord, sync, networkOnline, onRetry, onCopyError } = props
  useSyncExternalStore(subscribeCommandRegistry, getCommandRegistrySnapshot)
  const hints = listFooterHints(context)
  return (
    <footer
      data-testid="mail-footer"
      className="relative z-40 flex min-h-11 items-center gap-4 border-t border-edge bg-raised px-6 py-1.5 text-xs text-ink-faint shadow-footer"
    >
      <div
        data-testid="footer-shortcuts"
        className="flex min-w-0 flex-1 items-center gap-x-4 overflow-x-auto"
      >
        {pendingChord ? (
          <ChordGuide prefix={pendingChord} context={context} />
        ) : (
          hints.map((hint) => <FooterShortcut key={hint.id} {...hint} />)
        )}
      </div>
      <SyncStatus sync={sync} networkOnline={networkOnline} onRetry={onRetry} onCopyError={onCopyError} />
    </footer>
  )
}
