import type { MailboxView, MailLabel, SystemMailboxCounts } from '../../../shared/mail'
import { COMMAND_SPECS } from '../commands'
import { labelColor } from '../list/labelColor'
import {
  type MailView,
  type NavigableMailView,
  userLabelId,
  userLabelView,
  VIEW_TITLES
} from '../list/mailDisplay'
import { MailIcon } from './MailIcon'

const MAILBOX_ITEMS: readonly MailboxView[] = [
  'inbox',
  'starred',
  'snoozed',
  'drafts',
  'sent',
  'allMail',
  'spam',
  'trash'
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
  icon,
  count,
  shortcut,
  testId,
  onClick
}: {
  active: boolean
  title: string
  icon: React.ReactNode
  count?: number | null
  shortcut?: string
  testId: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      data-tooltip={shortcut ? `${title} (${shortcut.toUpperCase()})` : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={`group flex min-h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[12px] ${active ? 'bg-active font-semibold text-ink' : 'text-ink-dim hover:bg-active hover:text-ink'}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count != null && (
        <span
          className={`min-w-[27px] flex-none text-right text-[10px] tabular-nums ${active ? 'font-semibold' : 'font-normal'}`}
        >
          {count !== undefined && count !== null && (
            <span data-testid="sidebar-count" data-count={count} title={count.toLocaleString()}>
              {compactCount(count)}
            </span>
          )}
        </span>
      )}
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
      className="app-navigation-focus flex w-[190px] flex-none flex-col px-2.5 py-5"
      aria-label="Mail navigation"
    >
      <div
        data-testid="sidebar-brand"
        className="flex h-14 flex-none items-center px-2.5 pb-2 text-[26px] leading-none font-bold tracking-[-0.04em]"
      >
        attn:
      </div>
      <nav className="flex flex-none flex-col gap-0.5" aria-label="Mailboxes">
        <div className="flex min-h-8 items-center px-2.5 pb-1.5">
          <h2 className="text-[10px] font-normal text-ink-dim">Mailboxes</h2>
        </div>
        {MAILBOX_ITEMS.map((item) => (
          <NavButton
            key={item}
            active={view === item}
            title={VIEW_TITLES[item]}
            shortcut={COMMAND_SPECS[`view.${item}`].shortcut}
            icon={<MailIcon name={item} />}
            count={item === 'drafts' ? draftCount : mailboxCounts?.[item]}
            testId="sidebar-mailbox"
            onClick={() => onSwitchView(item)}
          />
        ))}
        <NavButton
          active={view === 'outbox'}
          title="Outbox"
          shortcut={COMMAND_SPECS['view.outbox'].shortcut}
          icon={<MailIcon name="outbox" />}
          count={outboxCount}
          testId="sidebar-outbox"
          onClick={onOpenOutbox}
        />
      </nav>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <h2 className="flex items-center gap-2.5 px-2.5 pb-1.5 text-[10px] font-normal text-ink-dim">
          <span>Labels</span>
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
                  count={label.threadCount}
                  icon={
                    <span
                      className="app-label-dot"
                      style={{ backgroundColor: labelColor(label.id).borderColor }}
                    />
                  }
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
