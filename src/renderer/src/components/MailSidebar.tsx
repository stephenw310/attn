import type { MailboxView, MailLabel, SystemMailboxCounts } from '../../../shared/mail'
import { COMMAND_SPECS } from '../commands'
import {
  type MailView,
  type NavigableMailView,
  userLabelId,
  userLabelView,
  VIEW_TITLES
} from '../list/mailDisplay'
import { formatShortcut } from '../platform'
import { Seal, TornRule } from './Hand'
import { Kbd } from './Kbd'

/** The width of the darker stock the sidebar is written on. `PaperSheet` tears
    the sheet at this offset, so the two have to agree. */
export const SIDEBAR_WIDTH = 216

const MAILBOX_ITEMS: readonly { view: MailboxView; shortcut: string }[] = [
  { view: 'inbox', shortcut: COMMAND_SPECS['view.inbox'].shortcut },
  { view: 'starred', shortcut: COMMAND_SPECS['view.starred'].shortcut },
  { view: 'snoozed', shortcut: COMMAND_SPECS['view.snoozed'].shortcut },
  { view: 'drafts', shortcut: COMMAND_SPECS['view.drafts'].shortcut },
  { view: 'sent', shortcut: COMMAND_SPECS['view.sent'].shortcut },
  { view: 'allMail', shortcut: COMMAND_SPECS['view.allMail'].shortcut },
  { view: 'spam', shortcut: COMMAND_SPECS['view.spam'].shortcut },
  { view: 'trash', shortcut: COMMAND_SPECS['view.trash'].shortcut }
]

function compactCount(count: number): string {
  if (count < 10_000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
  const millions = count / 1_000_000
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}m`
}

function NavButton({
  active,
  title,
  shortcut,
  count,
  testId,
  onClick
}: {
  active: boolean
  title: string
  shortcut?: string
  count?: number | null
  testId: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={`group relative flex min-h-8 w-full cursor-pointer items-baseline gap-2 pr-1 pl-3.5 text-left text-[15px] ${
        active ? 'font-bold text-ink' : 'text-ink-dim hover:text-ink'
      }`}
    >
      {/* The mark a reader leaves in the margin against the line they are on. */}
      {active && <span aria-hidden className="absolute top-[7px] left-0 h-4 w-[3px] bg-accent" />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {(shortcut || count != null) && (
        <span className="app-figures w-10 flex-none text-right text-[13px]">
          {count !== undefined && count !== null && (
            <span
              data-testid="sidebar-count"
              data-count={count}
              title={count.toLocaleString()}
              className={count > 0 ? 'text-ink-dim' : 'text-ink-faint'}
            >
              {compactCount(count)}
            </span>
          )}
        </span>
      )}
      {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
    </button>
  )
}

interface MailSidebarProps {
  view: MailView
  labels: readonly MailLabel[]
  mailboxCounts: SystemMailboxCounts | null
  draftCount: number
  outboxCount: number
  onSwitchView: (view: NavigableMailView) => void
  onOpenOutbox: () => void
}

export function MailSidebar(props: MailSidebarProps): React.JSX.Element {
  const { view, labels, mailboxCounts, draftCount, outboxCount, onSwitchView, onOpenOutbox } = props
  const activeLabelId = userLabelId(view)

  return (
    <aside
      id="mail-sidebar"
      data-testid="mail-sidebar"
      className="flex flex-none flex-col px-4 py-3"
      style={{ width: SIDEBAR_WIDTH }}
      aria-label="Mail navigation"
    >
      <div data-testid="sidebar-brand" className="flex-none px-1">
        <div className="font-gotisch flex items-center gap-2.5 text-[34px] leading-none text-ink">
          attn
          <Seal letter="a" />
        </div>
        <TornRule className="mt-3 w-full" />
      </div>
      <nav className="mt-5 flex flex-none flex-col gap-0.5" aria-label="Mailboxes">
        <div className="flex min-h-7 items-center px-1">
          <h2 className="app-small-caps text-[13px] text-accent">Mailboxes</h2>
        </div>
        {MAILBOX_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            active={view === item.view}
            title={VIEW_TITLES[item.view]}
            shortcut={item.shortcut}
            count={item.view === 'drafts' ? draftCount : mailboxCounts?.[item.view]}
            testId="sidebar-mailbox"
            onClick={() => onSwitchView(item.view)}
          />
        ))}
        <NavButton
          active={view === 'outbox'}
          title="Outbox"
          shortcut={COMMAND_SPECS['view.outbox'].shortcut}
          count={outboxCount}
          testId="sidebar-outbox"
          onClick={onOpenOutbox}
        />
      </nav>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <h2 className="app-small-caps flex items-center justify-between px-1 pb-1.5 text-[13px] text-accent">
          <span>Labels</span>
          <span className="app-figures text-ink-faint">{labels.length}</span>
        </h2>
        <nav data-testid="sidebar-labels" className="min-h-0 overflow-y-auto" aria-label="Labels">
          {labels.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-ink-faint">No labels</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {labels.map((label) => (
                <NavButton
                  key={label.id}
                  active={activeLabelId === label.id}
                  title={label.name}
                  testId="sidebar-label"
                  onClick={() => onSwitchView(userLabelView(label.id))}
                />
              ))}
            </div>
          )}
        </nav>
      </div>
    </aside>
  )
}
