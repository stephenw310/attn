import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TriageAction } from '../../shared/actions'
import type { AuthStatus } from '../../shared/auth'
import type { Conversation, SyncState, ThreadRow } from '../../shared/mail'
import { matchKey, registerCommands } from './commands'
import { MessageBody } from './MessageBody'
import { getConversation as getMockConversation, mockThreads } from './mockData'

interface DisplayThread {
  id: string
  from: string
  subject: string
  snippet: string
  at: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
}

interface DisplayMsg {
  id: string
  fromName: string
  fromEmail: string
  at: string
  text: string
  html: string | null
}

interface DisplayConversation {
  subject: string
  messages: DisplayMsg[]
}

const CHIP_CLASS = 'app-no-drag rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint'

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (dayDiff === 1) return 'Yesterday'
  if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fromThreadRow(r: ThreadRow): DisplayThread {
  return {
    id: r.id,
    from: r.fromDisplay || '(unknown)',
    subject: r.subject,
    snippet: r.snippet,
    at: formatTime(r.lastMsgAt),
    unread: r.unread,
    starred: r.starred,
    hasAttachment: r.hasAttachment
  }
}

function displayFromReal(c: Conversation): DisplayConversation {
  return {
    subject: c.subject,
    messages: c.messages.map((m) => ({
      id: m.id,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      at: formatTime(m.at),
      text: m.bodyText,
      html: m.bodyHtml
    }))
  }
}

function displayFromMockId(threadId: string): DisplayConversation {
  const c = getMockConversation(threadId)
  return {
    subject: c.subject,
    messages: c.messages.map((m) => ({
      id: m.id,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      at: m.at,
      text: m.body.join('\n\n'),
      html: null
    }))
  }
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[5px] border border-edge bg-active px-1.5 py-px text-[10.5px] font-medium text-ink-dim">
      {children}
    </kbd>
  )
}

function QueueReadout({ unread, pending }: { unread: number | null; pending: number }): React.JSX.Element {
  const lit = Math.min(unread ?? 0, 10)
  return (
    <div data-testid="queue-readout" className="flex items-center gap-3 text-xs text-ink-faint">
      <span className="flex items-center gap-[3px]" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size decorative meter — position is the identity
          <i key={i} className={`size-[5px] rounded-full ${i < lit ? 'bg-accent' : 'bg-edge'}`} />
        ))}
      </span>
      {unread === null ? (
        <span className="font-medium">counting…</span>
      ) : unread > 0 ? (
        <span className="font-medium text-ink-dim tabular-nums">
          <b className="font-semibold text-accent">{unread}</b> to zero
        </span>
      ) : (
        <span className="font-medium">at zero</span>
      )}
      {pending > 0 && <span data-testid="pending-count">· {pending} pending</span>}
    </div>
  )
}

function blurActive(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) el.blur()
}

function AccountMenu({
  status,
  onStatus
}: {
  status: AuthStatus | null
  onStatus: (s: AuthStatus) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    blurActive()
  }, [])

  const signIn = useCallback(() => {
    setBusy(true)
    setError(null)
    window.attn?.auth
      .signIn()
      .then(onStatus)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'sign-in failed'
        // A canceled flow means the user retried — the new attempt owns the UI.
        if (!msg.includes('sign-in canceled')) setError(msg)
      })
      .finally(() => setBusy(false))
  }, [onStatus])

  const signOut = useCallback(() => {
    closeMenu()
    window.attn?.auth
      .signOut()
      .then(onStatus)
      .catch(() => {})
  }, [closeMenu, onStatus])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
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

  if (!window.attn) return <div className={CHIP_CLASS}>mock data · browser preview</div>
  if (!status) return <div className={CHIP_CLASS}>…</div>
  if (!status.signedIn) {
    if (!status.configured) {
      return (
        <div
          className={CHIP_CLASS}
          title="Create your Google OAuth client, then add oauth.config.json — see the README"
        >
          OAuth not configured · see README
        </div>
      )
    }
    if (busy) return <div className={CHIP_CLASS}>waiting for Google…</div>
    return (
      <button
        type="button"
        className={`${CHIP_CLASS} cursor-pointer bg-active text-ink hover:border-accent`}
        onClick={signIn}
        title={error ?? undefined}
      >
        {error ? 'sign-in failed — retry' : 'Sign in with Google'}
      </button>
    )
  }

  return (
    <div ref={wrapRef} className="app-no-drag relative">
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

// The preload bridge is injected before renderer modules evaluate, so this is
// safe to read once at module scope (undefined in the plain-browser preview).
const attn = window.attn

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [mockReadIds, setMockReadIds] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const convCache = useRef(new Map<string, DisplayConversation>())
  const autoReadThreadRef = useRef<string | null>(null)
  const toastTokenRef = useRef(0)

  const activeAccount = status?.signedIn ? (status.email ?? null) : null
  const realMode = Boolean(attn && status?.signedIn)

  useEffect(() => {
    attn?.auth
      .getStatus()
      .then(setStatus)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!attn) return
    attn.sync
      .getState()
      .then(setSync)
      .catch(() => {})
    const offSync = attn.sync.onState(setSync)
    return offSync
  }, [])

  useEffect(() => {
    setRealThreads(null)
    setRealUnreadTotal(null)
    setSelectedIndex(0)
    setOverlayOpen(false)
    setPendingCount(0)
    setMockReadIds(new Set())
    setConversation(null)
    convCache.current.clear()

    if (!attn || !activeAccount) return
    let cancelled = false
    const refresh = (): void => {
      convCache.current.clear()
      void Promise.all([
        attn.mail.listThreads(),
        attn.mail.getUnreadCount(),
        attn.mail.getPendingActionCount()
      ])
        .then(([nextThreads, nextUnreadTotal, nextPendingCount]) => {
          if (cancelled) return
          setRealThreads(nextThreads)
          setRealUnreadTotal(nextUnreadTotal)
          setPendingCount(nextPendingCount)
        })
        .catch(() => {})
    }
    refresh()
    const offMail = attn.mail.onChanged(refresh)
    return () => {
      cancelled = true
      offMail()
    }
  }, [activeAccount])

  const threads: DisplayThread[] = useMemo(() => {
    if (realMode) return (realThreads ?? []).map(fromThreadRow)
    return mockThreads.map((t) => ({
      id: t.id,
      from: t.from,
      subject: t.subject,
      snippet: t.snippet,
      at: t.at,
      unread: t.unread,
      starred: t.starred ?? false,
      hasAttachment: t.hasAttachment ?? false
    }))
  }, [realMode, realThreads])

  useEffect(() => {
    // NOTE(M1 incremental sync): if a refresh removes the open thread, this
    // clamp shifts selection and an open overlay would jump to a different
    // conversation. Revisit when mail:changed can fire mid-read.
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(threads.length - 1, 0))))
    if (threads.length === 0) setOverlayOpen(false)
  }, [threads.length])

  const selected: DisplayThread | undefined = threads[selectedIndex]

  useEffect(() => {
    if (!selected) {
      setConversation(null)
      return
    }
    if (!realMode) {
      setConversation(displayFromMockId(selected.id))
      return
    }
    const cached = convCache.current.get(selected.id)
    if (cached) {
      setConversation(cached)
      return
    }
    if (!attn) return
    let cancelled = false
    setConversation(null)
    attn.mail
      .getConversation(selected.id)
      .then((c) => {
        if (cancelled || !c) return
        const d = displayFromReal(c)
        convCache.current.set(selected.id, d)
        setConversation(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selected, realMode])

  // Preload neighbors so Enter and in-overlay J/K render instantly (F3).
  useEffect(() => {
    if (!realMode || !attn) return
    for (const idx of [selectedIndex - 1, selectedIndex + 1]) {
      const t = threads[idx]
      if (!t || convCache.current.has(t.id)) continue
      attn.mail
        .getConversation(t.id)
        .then((c) => {
          if (c) convCache.current.set(t.id, displayFromReal(c))
        })
        .catch(() => {})
    }
  }, [selectedIndex, threads, realMode])

  const showToast = useCallback((message: string) => {
    const token = ++toastTokenRef.current
    setToast(message)
    window.setTimeout(() => {
      if (toastTokenRef.current === token) setToast(null)
    }, 4000)
  }, [])

  const triage = useCallback(
    (action: TriageAction) => {
      if (!realMode || !attn) return
      void attn.mail
        .triage(action)
        .then((result) => showToast(result.label))
        .catch(() => {})
    },
    [realMode, showToast]
  )

  const openSelected = useCallback(() => {
    const thread = threads[selectedIndex]
    if (!thread) return
    setOverlayOpen(true)
  }, [selectedIndex, threads])

  useEffect(() => {
    if (!overlayOpen) {
      autoReadThreadRef.current = null
      return
    }
    if (!selected || autoReadThreadRef.current === selected.id) return
    autoReadThreadRef.current = selected.id
    if (!selected.unread) return
    if (realMode) {
      void attn?.mail.markReadOnOpen(selected.id).catch(() => {})
    } else {
      setMockReadIds((current) => (current.has(selected.id) ? current : new Set(current).add(selected.id)))
    }
  }, [overlayOpen, realMode, selected])

  useLayoutEffect(
    () =>
      registerCommands([
        {
          id: 'navigate.next',
          title: 'Next conversation',
          shortcut: 'j',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => setSelectedIndex((i) => Math.min(i + 1, Math.max(threads.length - 1, 0)))
        },
        {
          id: 'navigate.previous',
          title: 'Previous conversation',
          shortcut: 'k',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => setSelectedIndex((i) => Math.max(i - 1, 0))
        },
        {
          id: 'conversation.open',
          title: 'Open conversation',
          shortcut: 'Enter',
          context: 'list',
          run: openSelected
        },
        {
          id: 'conversation.close',
          title: 'Close conversation',
          shortcut: 'Escape',
          context: 'overlay',
          run: () => setOverlayOpen(false)
        },
        {
          id: 'triage.archive',
          title: 'Mark done',
          shortcut: 'e',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => selected && triage({ kind: 'archive', threadIds: [selected.id] })
        },
        {
          id: 'triage.trash',
          title: 'Move to trash',
          shortcut: '#',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => selected && triage({ kind: 'trash', threadIds: [selected.id] })
        },
        {
          id: 'triage.spam',
          title: 'Mark as spam',
          shortcut: '!',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => selected && triage({ kind: 'spam', threadIds: [selected.id] })
        },
        {
          id: 'triage.star',
          title: selected?.starred ? 'Unstar' : 'Star',
          shortcut: 's',
          context: overlayOpen ? 'overlay' : 'list',
          run: () => selected && triage({ kind: 'star', threadIds: [selected.id], on: !selected.starred })
        },
        {
          id: 'triage.unread',
          title: selected?.unread ? 'Mark read' : 'Mark unread',
          shortcut: 'u',
          context: overlayOpen ? 'overlay' : 'list',
          run: () =>
            selected && triage({ kind: 'markUnread', threadIds: [selected.id], on: !selected.unread })
        },
        {
          id: 'triage.undo',
          title: 'Undo',
          shortcut: 'z',
          context: 'global',
          run: () => {
            if (!realMode || !attn) return
            void attn.mail
              .undo()
              .then((result) => {
                if (result) showToast(result.label)
              })
              .catch(() => {})
          }
        }
      ]),
    [openSelected, overlayOpen, realMode, selected, showToast, threads.length, triage]
  )

  useLayoutEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'BUTTON' ||
          target.isContentEditable)
      ) {
        return
      }
      const command = matchKey(e, overlayOpen ? 'overlay' : 'list')
      if (!command) return
      e.preventDefault()
      command.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlayOpen])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex is a deliberate trigger — scroll after every selection change, ref itself never changes
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const visibleUnreadTotal = threads.filter((t) => t.unread).length
  const mockReadTotal = threads.filter((t) => t.unread && mockReadIds.has(t.id)).length
  const unreadCount =
    realMode && realUnreadTotal === null
      ? null
      : realMode
        ? (realUnreadTotal ?? 0)
        : visibleUnreadTotal - mockReadTotal

  const statusNote =
    sync.phase === 'syncing'
      ? `syncing… ${sync.threadsDone} threads`
      : sync.phase === 'error'
        ? `sync failed — ${sync.message.slice(0, 80)}`
        : realMode
          ? 'live Gmail data'
          : 'mock data'

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex items-center gap-6 border-b border-edge px-6 py-3">
        <div className="text-base font-bold tracking-tight">
          attn<span className="text-accent">:</span>
        </div>
        <nav className="app-no-drag flex gap-1">
          <button
            type="button"
            className="cursor-pointer rounded-[7px] bg-active px-3 py-1.5 text-[13px] font-medium text-ink"
          >
            Important
            {unreadCount !== null && unreadCount > 0 && (
              <span className="ml-1.5 text-xs font-semibold text-accent tabular-nums">{unreadCount}</span>
            )}
          </button>
          <button
            type="button"
            disabled
            title="Split inbox lands at M3 (F11)"
            className="rounded-[7px] px-3 py-1.5 text-[13px] font-medium text-ink-faint disabled:opacity-60"
          >
            Other
          </button>
        </nav>
        <div className="app-no-drag ml-auto flex items-center gap-4">
          <QueueReadout unread={unreadCount} pending={pendingCount} />
          <div data-testid="account-menu">
            <AccountMenu status={status} onStatus={setStatus} />
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto py-2" aria-label="Conversation list">
        {threads.length === 0 && (
          <div className="flex h-full items-center justify-center text-ink-faint">
            {sync.phase === 'syncing' ? 'Syncing your inbox…' : 'Inbox empty'}
          </div>
        )}
        {threads.map((t, i) => {
          const isSelected = i === selectedIndex
          const isUnread = t.unread && !mockReadIds.has(t.id)
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global (J/K/Enter, F3) — clicks are a supplementary pointer target
            // biome-ignore lint/a11y/noStaticElementInteractions: same — row selection is driven by the app-level key handler, not per-row focus
            <div
              key={t.id}
              ref={isSelected ? selectedRowRef : null}
              data-testid="thread-row"
              data-selected={isSelected || undefined}
              data-unread={isUnread || undefined}
              className={`flex cursor-default items-center gap-3.5 whitespace-nowrap border-l-[3px] py-[11px] pr-7 pl-5 ${
                isSelected ? 'border-l-accent bg-accent/[0.07]' : 'border-l-transparent'
              }`}
              onClick={() => setSelectedIndex(i)}
              onDoubleClick={() => {
                setSelectedIndex(i)
                setOverlayOpen(true)
              }}
            >
              <span
                className={`size-1.5 flex-none rounded-full ${
                  isUnread ? 'bg-accent shadow-[0_0_6px_rgba(255,178,36,0.45)]' : 'bg-transparent'
                }`}
                aria-hidden
              />
              <span
                className={`w-52 flex-none overflow-hidden text-ellipsis ${
                  isUnread ? 'font-semibold text-ink' : 'text-ink-dim'
                }`}
              >
                {t.from}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis text-ink-faint">
                <span className={isUnread ? 'font-semibold text-ink' : 'text-ink-dim'}>{t.subject}</span>
                <span> — {t.snippet}</span>
              </span>
              <span className="flex flex-none items-center gap-2.5 text-xs">
                {t.hasAttachment && <span title="Has attachment">📎</span>}
                {t.starred && (
                  <span className="text-star" title="Starred">
                    ★
                  </span>
                )}
                <span
                  className={`min-w-[70px] text-right tabular-nums ${
                    isUnread ? 'font-medium text-accent' : 'text-ink-faint'
                  }`}
                >
                  {t.at}
                </span>
              </span>
            </div>
          )
        })}
      </main>

      {overlayOpen && selected && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc is the keyboard path to close (global handler) — backdrop click is the pointer equivalent */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: same — dismiss-on-backdrop is a convention, not the primary control */}
          <div className="fixed inset-0 z-20 bg-[rgba(8,9,11,0.62)]" onClick={() => setOverlayOpen(false)} />
          <div
            data-testid="conversation-overlay"
            className="fixed top-[7vh] left-1/2 z-30 flex max-h-[80vh] w-[min(780px,92vw)] -translate-x-1/2 flex-col rounded-[13px] border border-edge bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
          >
            <div className="flex items-center gap-3 border-b border-edge px-6 pt-4 pb-3">
              <h1
                data-testid="conversation-subject"
                className="min-w-0 flex-1 text-lg font-bold tracking-tight"
              >
                {conversation?.subject ?? selected.subject}
              </h1>
              <span className="flex flex-none items-center gap-2 text-xs text-ink-faint">
                <span data-testid="conversation-position" className="tabular-nums">
                  {selectedIndex + 1} of {threads.length}
                </span>
                · <Kbd>Esc</Kbd>
              </span>
            </div>
            <div data-testid="conversation-scroll" className="overflow-y-auto px-6 pt-4 pb-6">
              {conversation ? (
                <div className="flex flex-col gap-3.5">
                  {conversation.messages.map((m) => (
                    <article
                      key={m.id}
                      data-testid="message-card"
                      className="rounded-[10px] border border-edge bg-ground px-5 py-4"
                    >
                      <div className="mb-2.5 flex items-baseline gap-2.5">
                        <span className="font-semibold">{m.fromName}</span>
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-faint">
                          &lt;{m.fromEmail}&gt;
                        </span>
                        <span className="flex-none text-xs text-ink-faint tabular-nums">{m.at}</span>
                      </div>
                      <MessageBody bodyText={m.text} bodyHtml={m.html} />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="py-10 text-center text-ink-faint">Loading…</div>
              )}
            </div>
          </div>
        </>
      )}

      {toast && (
        <div
          data-testid="toast"
          className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-edge bg-raised px-4 py-2 text-sm text-ink shadow-lg"
        >
          {toast}
        </div>
      )}

      <footer className="relative z-40 flex items-center gap-4 border-t border-edge bg-ground px-6 py-2 text-xs text-ink-faint">
        {overlayOpen ? (
          <>
            <span>
              <Kbd>J</Kbd>/<Kbd>K</Kbd> next / prev
            </span>
            <span>
              <Kbd>Esc</Kbd> close
            </span>
          </>
        ) : (
          <>
            <span>
              <Kbd>J</Kbd>/<Kbd>K</Kbd> navigate
            </span>
            <span>
              <Kbd>Enter</Kbd> open
            </span>
          </>
        )}
        <span
          data-testid="status-note"
          className={`ml-auto font-medium ${sync.phase === 'error' ? 'text-danger' : ''}`}
          title={statusNote}
        >
          {statusNote}
        </span>
      </footer>
    </div>
  )
}
