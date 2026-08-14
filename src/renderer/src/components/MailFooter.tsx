import type { SyncState } from '../../../shared/mail'
import { Kbd } from './Kbd'
import { SyncStatus } from './SyncStatus'

interface ShortcutHint {
  id: string
  keys: string[]
  label: string
}

const TRIAGE_SHORTCUT_HINTS: ShortcutHint[] = [
  { id: 'done', keys: ['E'], label: 'done' },
  { id: 'snooze', keys: ['H'], label: 'snooze' },
  { id: 'label', keys: ['L'], label: 'label' },
  { id: 'trash', keys: ['#'], label: 'trash' },
  { id: 'star', keys: ['S'], label: 'star' },
  { id: 'unread', keys: ['U'], label: 'unread' },
  { id: 'spam', keys: ['!'], label: 'spam' },
  { id: 'undo', keys: ['Z'], label: 'undo' }
]

function footerShortcuts(readerOpen: boolean): ShortcutHint[] {
  return [
    ...(readerOpen
      ? [
          { id: 'navigate', keys: ['J', 'K'], label: 'next conversation' },
          { id: 'scroll', keys: ['↑', '↓', 'Space'], label: 'scroll' },
          { id: 'back', keys: ['Esc'], label: 'back to list' }
        ]
      : [
          { id: 'navigate', keys: ['J', 'K', '↑', '↓'], label: 'navigate' },
          { id: 'open', keys: ['Enter'], label: 'open' }
        ]),
    { id: 'select', keys: ['X'], label: 'select' },
    ...TRIAGE_SHORTCUT_HINTS
  ]
}

function FooterShortcut({ id, keys, label }: ShortcutHint): React.JSX.Element {
  return (
    <span
      data-testid={`footer-shortcut-${id}`}
      className="flex items-center gap-1.5 whitespace-nowrap text-ink-dim"
    >
      <span className="flex items-center gap-0.5">
        {keys.map((key, index) => (
          <span key={key} className="contents">
            {index > 0 && <span aria-hidden>/</span>}
            <Kbd>{key}</Kbd>
          </span>
        ))}
      </span>
      {label}
    </span>
  )
}

interface MailFooterProps {
  readerOpen: boolean
  sync: SyncState
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}

export function MailFooter(props: MailFooterProps): React.JSX.Element {
  const { readerOpen, sync, networkOnline, onRetry, onCopyError } = props
  return (
    <footer className="relative z-40 flex min-h-11 items-center gap-4 border-t border-white/10 bg-raised px-6 py-1.5 text-xs text-ink-faint shadow-[0_-8px_24px_rgba(0,0,0,0.32)]">
      <div data-testid="footer-shortcuts" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {footerShortcuts(readerOpen).map((shortcut) => (
          <FooterShortcut key={shortcut.id} {...shortcut} />
        ))}
      </div>
      <SyncStatus sync={sync} networkOnline={networkOnline} onRetry={onRetry} onCopyError={onCopyError} />
    </footer>
  )
}
