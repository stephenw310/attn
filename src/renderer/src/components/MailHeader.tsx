import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import { COMMAND_SPECS } from '../commands'
import { type MailView, VIEW_TITLES } from '../mailDisplay'
import { blurActive } from './blurActive'
import { Kbd } from './Kbd'

const CHIP_CLASS = 'app-no-drag rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint'
const QUEUE_METER_STEPS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function QueueReadout({
  unread,
  pendingActions,
  pausedActions,
  outbox,
  onReconnect,
  onOpenOutbox
}: {
  unread: number | null
  pendingActions: number
  pausedActions: number
  outbox: number
  onReconnect: () => void
  onOpenOutbox?: () => void
}): React.JSX.Element {
  const lit = Math.min(unread ?? 0, 10)
  return (
    <div data-testid="queue-readout" className="flex items-center gap-3 text-xs text-ink-faint">
      <span className="flex items-center gap-[3px]" aria-hidden>
        {QUEUE_METER_STEPS.map((step, index) => (
          <i key={step} className={`size-[5px] rounded-full ${index < lit ? 'bg-accent' : 'bg-edge'}`} />
        ))}
      </span>
      {unread === null ? (
        <span className="font-medium">counting…</span>
      ) : unread > 0 ? (
        <span className="font-medium text-ink-dim tabular-nums">
          <b data-testid="queue-unread" className="font-semibold text-accent">
            {unread}
          </b>{' '}
          to zero
        </span>
      ) : (
        <span className="font-medium">at zero</span>
      )}
      {pendingActions > 0 && (
        <span data-testid="pending-count" className="font-medium tabular-nums">
          · {pendingActions} pending
        </span>
      )}
      {outbox > 0 && (
        <button
          type="button"
          data-testid="outbox-count"
          disabled={!onOpenOutbox}
          className="cursor-pointer rounded px-1 py-0.5 hover:bg-active hover:text-ink-dim disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-inherit"
          onClick={onOpenOutbox}
        >
          · {outbox} in Outbox
        </button>
      )}
      {/* Paused rows are a subset of `pendingActions` — the rest of the queue is
          still draining — and outbox sends can never be auth-paused at all, so
          the reconnect control is its own readout rather than a relabeled count. */}
      {pausedActions > 0 && (
        <button
          type="button"
          data-testid="action-reconnect"
          onClick={onReconnect}
          title="Google authorization expired; reconnect to retry paused changes"
          className="cursor-pointer font-medium text-accent hover:underline"
        >
          <span data-testid="paused-count">· {pausedActions} paused</span> · Reconnect Google
        </button>
      )}
    </div>
  )
}

const MAILBOX_MENU_ITEMS: { view: Exclude<MailView, 'outbox'>; shortcut: string }[] = [
  { view: 'inbox', shortcut: COMMAND_SPECS['view.inbox'].shortcut },
  { view: 'allMail', shortcut: COMMAND_SPECS['view.allMail'].shortcut },
  { view: 'sent', shortcut: COMMAND_SPECS['view.sent'].shortcut },
  { view: 'drafts', shortcut: COMMAND_SPECS['view.drafts'].shortcut },
  { view: 'starred', shortcut: COMMAND_SPECS['view.starred'].shortcut },
  { view: 'snoozed', shortcut: COMMAND_SPECS['view.snoozed'].shortcut },
  { view: 'spam', shortcut: COMMAND_SPECS['view.spam'].shortcut },
  { view: 'trash', shortcut: COMMAND_SPECS['view.trash'].shortcut }
]

/**
 * The active mailbox name plus a menu of every mailbox: v1 keeps D6's minimal
 * chrome by naming the mailbox in the list header instead of adding a folder
 * sidebar (SPEC F3). Outbox stays out of the menu — it is an on-demand
 * operational view reached from the pending readout and its G chord.
 */
function MailboxMenu({
  view,
  onSwitchView
}: {
  view: MailView
  onSwitchView: (view: Exclude<MailView, 'outbox'>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    blurActive()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeMenu, open])

  return (
    <div ref={wrapRef} className="app-no-drag relative">
      <button
        type="button"
        data-testid="mailbox-menu"
        className="flex cursor-pointer items-center gap-1.5 rounded-[7px] bg-active px-3 py-1.5 text-[13px] font-semibold text-ink"
        onClick={() => (open ? closeMenu() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {/* The chip is the one header element naming the active view; OutboxList
            renders its own view-title, so the alias skips the outbox view. */}
        <span data-testid="mailbox-title">
          {view === 'outbox' ? VIEW_TITLES[view] : <span data-testid="view-title">{VIEW_TITLES[view]}</span>}
        </span>{' '}
        <span className="text-[8px] text-ink-faint">▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-2 w-[210px] rounded-lg border border-edge bg-raised p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
          {MAILBOX_MENU_ITEMS.map((item) => (
            <button
              key={item.view}
              type="button"
              data-testid="mailbox-row"
              data-view={item.view}
              data-active={item.view === view || undefined}
              onClick={() => {
                closeMenu()
                onSwitchView(item.view)
              }}
              className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] hover:bg-active hover:text-ink ${
                item.view === view ? 'font-semibold text-ink' : 'text-ink-dim'
              }`}
            >
              {VIEW_TITLES[item.view]}
              <Kbd>{item.shortcut.toUpperCase()}</Kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AccountMenu({
  status,
  onStatus
}: {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    blurActive()
  }, [])

  const signOut = useCallback(() => {
    closeMenu()
    window.attn?.auth
      .signOut()
      .then(onStatus)
      .catch(() => {})
  }, [closeMenu, onStatus])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeMenu()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeMenu, open])

  return (
    <div ref={wrapRef} data-testid="account-menu" className="app-no-drag relative">
      <button
        type="button"
        className={`${CHIP_CLASS} flex cursor-pointer items-center gap-1.5 hover:border-accent hover:text-ink-dim`}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {status.email ?? 'signed in'} <span className="text-[8px]">▾</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[230px] rounded-lg border border-edge bg-raised p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
          <button
            type="button"
            disabled
            title="Settings surface lands at M4"
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim opacity-45"
          >
            Settings <Kbd>⌘ ,</Kbd>
          </button>
          <button
            type="button"
            disabled
            title="Cheat sheet lands at M4"
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim opacity-45"
          >
            Keyboard shortcuts <Kbd>⌘ /</Kbd>
          </button>
          <button
            type="button"
            disabled
            title="Split rules land at M3"
            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim opacity-45"
          >
            Split rules…
          </button>
          <hr className="my-1.5 border-edge" />
          <button
            type="button"
            onClick={signOut}
            title="Tokens are removed; sign back in any time — local mail stays cached"
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

interface MailHeaderProps {
  view: MailView
  unreadCount: number | null
  pendingActionCount: number
  pausedActionCount: number
  outboxCount: number
  selectionCount: number
  composerOpen: boolean
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
  onReconnectActions: () => void
  onSwitchView: (view: Exclude<MailView, 'outbox'>) => void
  onOpenOutbox: () => void
}

export function MailHeader(props: MailHeaderProps): React.JSX.Element {
  const {
    view,
    unreadCount,
    pendingActionCount,
    pausedActionCount,
    outboxCount,
    selectionCount,
    composerOpen,
    status,
    onStatus,
    onReconnectActions,
    onSwitchView,
    onOpenOutbox
  } = props
  return (
    <header className="app-drag flex items-center gap-6 border-b border-edge px-6 py-3">
      <div className="text-base font-bold tracking-tight">
        attn<span className="text-accent">:</span>
      </div>
      {!composerOpen && (
        // The mailbox menu chip names the active view, so the quick buttons
        // cover only the other two of the frequent trio — one control per view.
        <nav className="app-no-drag flex items-center gap-1">
          <MailboxMenu view={view} onSwitchView={onSwitchView} />
          {view !== 'inbox' && (
            <button
              type="button"
              onClick={() => onSwitchView('inbox')}
              className="cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium text-ink-faint hover:text-ink-dim"
            >
              Inbox
              {unreadCount !== null && unreadCount > 0 && (
                <span className="ml-1.5 text-xs font-semibold text-accent tabular-nums">{unreadCount}</span>
              )}
            </button>
          )}
          {view !== 'snoozed' && (
            <button
              type="button"
              onClick={() => onSwitchView('snoozed')}
              className="cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium text-ink-faint hover:text-ink-dim"
            >
              Snoozed
            </button>
          )}
          {view !== 'drafts' && (
            <button
              type="button"
              data-testid="view-drafts"
              onClick={() => onSwitchView('drafts')}
              className="cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium text-ink-faint hover:text-ink-dim"
            >
              Drafts
            </button>
          )}
        </nav>
      )}
      <div className="app-no-drag ml-auto flex items-center gap-4">
        {!composerOpen && selectionCount > 0 && (
          <span
            data-testid="selection-count"
            className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent tabular-nums"
          >
            {selectionCount} selected
          </span>
        )}
        <QueueReadout
          unread={unreadCount}
          pendingActions={pendingActionCount}
          pausedActions={pausedActionCount}
          outbox={outboxCount}
          onReconnect={onReconnectActions}
          onOpenOutbox={composerOpen ? undefined : onOpenOutbox}
        />
        <AccountMenu status={status} onStatus={onStatus} />
      </div>
    </header>
  )
}
