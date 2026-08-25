import type { MailboxView, MailLabel, SystemMailboxCounts } from '../../../shared/mail'
import { COMMAND_SPECS } from '../commands'
import {
  type MailView,
  type NavigableMailView,
  userLabelId,
  userLabelView,
  VIEW_TITLES
} from '../mailDisplay'
import { Kbd } from './Kbd'

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
      className={`group flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border-l-2 px-2.5 text-left text-[13px] ${
        active
          ? 'border-l-accent bg-active font-semibold text-ink'
          : 'border-l-transparent font-medium text-ink-dim hover:bg-active/70 hover:text-ink'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count !== undefined && count !== null && (
        <span
          data-testid="sidebar-count"
          data-count={count}
          title={count.toLocaleString()}
          className={`text-[11px] font-semibold tabular-nums ${count > 0 ? 'text-accent' : 'text-ink-faint'}`}
        >
          {compactCount(count)}
        </span>
      )}
      {shortcut && <Kbd>{shortcut.toUpperCase()}</Kbd>}
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
      className="flex w-54 flex-none flex-col border-r border-edge bg-raised/45 px-3 py-3"
      aria-label="Mail navigation"
    >
      <div
        data-testid="sidebar-brand"
        className="flex h-14 flex-none items-center px-2.5 pb-2 text-[40px] leading-none font-bold tracking-[-0.04em]"
      >
        attn<span className="text-accent">:</span>
      </div>
      <nav className="flex flex-none flex-col gap-0.5" aria-label="Mailboxes">
        <div className="flex min-h-8 items-center px-2.5 pb-1.5">
          <h2 className="text-[10px] font-bold tracking-[0.14em] text-ink-faint uppercase">Mailboxes</h2>
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

      <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-edge pt-3">
        <h2 className="flex items-center justify-between px-2.5 pb-1.5 text-[10px] font-bold tracking-[0.14em] text-ink-faint uppercase">
          <span>Labels</span>
          <span className="font-medium tracking-normal tabular-nums">{labels.length}</span>
        </h2>
        <nav data-testid="sidebar-labels" className="min-h-0 overflow-y-auto" aria-label="Labels">
          {labels.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-ink-faint">No labels</p>
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
