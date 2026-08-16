import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import { blurActive } from './blurActive'
import { Kbd } from './Kbd'

const CHIP_CLASS = 'app-no-drag rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint'
const QUEUE_METER_STEPS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function QueueReadout({ unread, pending }: { unread: number | null; pending: number }): React.JSX.Element {
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
      {pending > 0 && <span data-testid="pending-count">· {pending} pending</span>}
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
  view: 'inbox' | 'snoozed' | 'drafts'
  unreadCount: number | null
  pendingCount: number
  selectionCount: number
  composerOpen: boolean
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
  onSwitchView: (view: 'inbox' | 'snoozed' | 'drafts') => void
}

export function MailHeader(props: MailHeaderProps): React.JSX.Element {
  const { view, unreadCount, pendingCount, selectionCount, composerOpen, status, onStatus, onSwitchView } =
    props
  return (
    <header className="app-drag flex items-center gap-6 border-b border-edge px-6 py-3">
      <div className="text-base font-bold tracking-tight">
        attn<span className="text-accent">:</span>
      </div>
      {!composerOpen && (
        <nav className="app-no-drag flex gap-1">
          <button
            type="button"
            onClick={() => onSwitchView('inbox')}
            className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
              view === 'inbox' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            <span data-testid={view === 'inbox' ? 'view-title' : undefined}>Inbox</span>
            {unreadCount !== null && unreadCount > 0 && (
              <span className="ml-1.5 text-xs font-semibold text-accent tabular-nums">{unreadCount}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onSwitchView('snoozed')}
            className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
              view === 'snoozed' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            <span data-testid={view === 'snoozed' ? 'view-title' : undefined}>Snoozed</span>
          </button>
          <button
            type="button"
            data-testid="view-drafts"
            onClick={() => onSwitchView('drafts')}
            className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
              view === 'drafts' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            <span data-testid={view === 'drafts' ? 'view-title' : undefined}>Drafts</span>
          </button>
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
        <QueueReadout unread={unreadCount} pending={pendingCount} />
        <AccountMenu status={status} onStatus={onStatus} />
      </div>
    </header>
  )
}
