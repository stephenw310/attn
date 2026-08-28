import type { SyncState } from '../../../shared/mail'
import { modKeyLabel } from '../platform'
import { Kbd } from './Kbd'
import { SyncStatus } from './SyncStatus'

interface ShortcutHint {
  id: string
  /** Alternatives by default (`J / K`); a chord is pressed together (`⌘ + Enter`). */
  keys: string[]
  chord?: boolean
  label: string
}

const TRIAGE_SHORTCUT_HINTS: ShortcutHint[] = [
  { id: 'done', keys: ['E'], label: 'done' },
  { id: 'snooze', keys: ['H'], label: 'snooze' },
  { id: 'move', keys: ['V'], label: 'move' },
  { id: 'label', keys: ['L'], label: 'label' },
  { id: 'trash', keys: ['#'], label: 'trash' },
  { id: 'star', keys: ['S'], label: 'star' },
  { id: 'unread', keys: ['U'], label: 'unread' },
  { id: 'spam', keys: ['!'], label: 'spam' },
  { id: 'undo', keys: ['Z'], label: 'undo' }
]

function footerShortcuts(
  readerOpen: boolean,
  outboxOpen: boolean,
  composing: boolean,
  searchEditing: boolean,
  moveAllowed: boolean
): ShortcutHint[] {
  // An inline composer keeps the list and reader on screen but owns the
  // keyboard, so advertise the composer's keys rather than dead triage verbs.
  if (composing) {
    return [
      { id: 'send', keys: [modKeyLabel(), 'Enter'], chord: true, label: 'send' },
      { id: 'back', keys: ['Esc'], label: 'save and close' }
    ]
  }
  if (searchEditing) {
    return [
      { id: 'search-browse', keys: ['Enter'], label: 'search' },
      { id: 'search-close', keys: ['Esc'], label: 'close search' }
    ]
  }
  if (outboxOpen) {
    return [
      { id: 'navigate', keys: ['J', 'K', '↑', '↓'], label: 'navigate' },
      { id: 'open', keys: ['Enter'], label: 'open' },
      { id: 'back', keys: ['Esc'], label: 'back' },
      { id: 'undo', keys: ['Z'], label: 'undo' }
    ]
  }
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
    ...TRIAGE_SHORTCUT_HINTS.filter((shortcut) => shortcut.id !== 'move' || moveAllowed)
  ]
}

function FooterShortcut({ id, keys, chord, label }: ShortcutHint): React.JSX.Element {
  return (
    <span
      data-testid={`footer-shortcut-${id}`}
      className="flex items-center gap-1.5 whitespace-nowrap text-ink-dim"
    >
      <span className="flex items-center gap-0.5">
        {keys.map((key, index) => (
          <span key={key} className="contents">
            {index > 0 && <span aria-hidden>{chord ? '+' : '/'}</span>}
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
  outboxOpen: boolean
  composing: boolean
  searchEditing: boolean
  moveAllowed: boolean
  sync: SyncState
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}

export function MailFooter(props: MailFooterProps): React.JSX.Element {
  const {
    readerOpen,
    outboxOpen,
    composing,
    searchEditing,
    moveAllowed,
    sync,
    networkOnline,
    onRetry,
    onCopyError
  } = props
  return (
    <footer
      data-testid="mail-footer"
      className="relative z-40 flex min-h-11 items-center gap-4 border-t border-edge bg-raised px-6 py-1.5 text-xs text-ink-faint shadow-footer"
    >
      <div data-testid="footer-shortcuts" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {footerShortcuts(readerOpen, outboxOpen, composing, searchEditing, moveAllowed).map((shortcut) => (
          <FooterShortcut key={shortcut.id} {...shortcut} />
        ))}
      </div>
      <SyncStatus sync={sync} networkOnline={networkOnline} onRetry={onRetry} onCopyError={onCopyError} />
    </footer>
  )
}
