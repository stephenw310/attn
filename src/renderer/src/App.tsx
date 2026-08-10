import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../shared/auth'
import type { Conversation, SyncState, ThreadRow } from '../../shared/mail'
import { getConversation as getMockConversation, mockThreads } from './mockData'

type FocusRegion = 'list' | 'conversation'

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
      text: m.bodyText
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
      text: m.body.join('\n\n')
    }))
  }
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-edge bg-active px-[5px] py-px font-sans text-[11px]">
      {children}
    </kbd>
  )
}

function AccountChip({
  status,
  onStatus
}: {
  status: AuthStatus | null
  onStatus: (s: AuthStatus) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  if (!window.attn) return <div className={CHIP_CLASS}>mock data · browser preview</div>
  if (!status) return <div className={CHIP_CLASS}>…</div>
  if (status.signedIn) return <div className={CHIP_CLASS}>{status.email ?? 'signed in'}</div>
  if (!status.configured) {
    return (
      <div
        className={CHIP_CLASS}
        title="Create your Google OAuth client, then add oauth.config.json — see SETUP.md"
      >
        OAuth not configured · see SETUP.md
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

// The preload bridge is injected before renderer modules evaluate, so this is
// safe to read once at module scope (undefined in the plain-browser preview).
const attn = window.attn

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusRegion, setFocusRegion] = useState<FocusRegion>('list')
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set())
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const convCache = useRef(new Map<string, DisplayConversation>())

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
    const offMail = attn.mail.onChanged(() => {
      convCache.current.clear()
      attn.mail
        .listThreads()
        .then(setRealThreads)
        .catch(() => {})
    })
    return () => {
      offSync()
      offMail()
    }
  }, [])

  useEffect(() => {
    if (realMode && attn)
      attn.mail
        .listThreads()
        .then(setRealThreads)
        .catch(() => {})
  }, [realMode])

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
    setSelectedIndex((i) => Math.min(i, Math.max(threads.length - 1, 0)))
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

  const openConversation = useCallback((threadId: string) => {
    setFocusRegion('conversation')
    setReadIds((prev) => (prev.has(threadId) ? prev : new Set(prev).add(threadId)))
  }, [])

  useEffect(() => {
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
      if (threads.length === 0) return
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, threads.length - 1))
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (threads[selectedIndex]) openConversation(threads[selectedIndex].id)
          break
        case 'Escape':
          e.preventDefault()
          setFocusRegion('list')
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIndex, threads, openConversation])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex is a deliberate trigger — scroll after every selection change, ref itself never changes
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const unreadCount = threads.filter((t) => t.unread && !readIds.has(t.id)).length

  const statusNote =
    sync.phase === 'syncing'
      ? `syncing… ${sync.threadsDone} threads`
      : sync.phase === 'error'
        ? `sync failed — ${sync.message.slice(0, 80)}`
        : realMode
          ? 'live Gmail data'
          : 'M0 walking skeleton · mock data'

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex items-center justify-between border-b border-edge px-4 py-2.5">
        <div className="app-no-drag flex gap-1">
          <button
            type="button"
            className="cursor-pointer rounded-md bg-active px-3 py-1.5 text-[13px] font-medium text-ink"
          >
            Important{' '}
            <span data-testid="unread-count" className="ml-1.5 text-[11px] text-accent">
              {unreadCount}
            </span>
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-dim disabled:cursor-default disabled:opacity-50"
            disabled
            title="Split inbox lands at M3 (F11)"
          >
            Other
          </button>
        </div>
        <div data-testid="account-chip">
          <AccountChip status={status} onStatus={setStatus} />
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <section
          className="w-[42%] min-w-[360px] max-w-[560px] overflow-y-auto border-r border-edge py-1.5"
          aria-label="Conversation list"
        >
          {threads.length === 0 && (
            <div className="flex h-full items-center justify-center text-ink-faint">
              {sync.phase === 'syncing' ? 'Syncing your inbox…' : 'Inbox empty'}
            </div>
          )}
          {threads.map((t, i) => {
            const isSelected = i === selectedIndex
            const isUnread = t.unread && !readIds.has(t.id)
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global (J/K/Enter, F3) — clicks are a supplementary pointer target
              // biome-ignore lint/a11y/noStaticElementInteractions: same — row selection is driven by the app-level key handler, not per-row focus
              <div
                key={t.id}
                ref={isSelected ? selectedRowRef : null}
                data-testid="thread-row"
                data-selected={isSelected || undefined}
                data-unread={isUnread || undefined}
                className={`flex cursor-default items-center gap-2.5 whitespace-nowrap border-l-2 py-[9px] pr-3.5 pl-2.5 ${
                  isSelected ? 'border-l-accent bg-active' : 'border-l-transparent'
                }`}
                onClick={() => setSelectedIndex(i)}
                onDoubleClick={() => openConversation(t.id)}
              >
                <span
                  className={`size-[7px] flex-none rounded-full ${isUnread ? 'bg-accent' : 'bg-transparent'}`}
                  aria-hidden
                />
                <span
                  className={`w-32 flex-none overflow-hidden text-ellipsis ${
                    isUnread ? 'font-semibold text-ink' : 'text-ink-dim'
                  }`}
                >
                  {t.from}
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis text-ink-faint">
                  <span className={isUnread ? 'font-semibold text-ink' : 'text-ink-dim'}>{t.subject}</span>
                  <span> — {t.snippet}</span>
                </span>
                <span className="flex flex-none items-center gap-1.5 text-xs text-ink-faint">
                  {t.hasAttachment && <span title="Has attachment">📎</span>}
                  {t.starred && (
                    <span className="text-star" title="Starred">
                      ★
                    </span>
                  )}
                  <span className="min-w-[58px] text-right">{t.at}</span>
                </span>
              </div>
            )
          })}
        </section>

        <section
          data-focus={focusRegion}
          className={`min-w-0 flex-1 overflow-y-auto border-t-2 ${
            focusRegion === 'conversation' ? 'border-t-accent' : 'border-t-transparent'
          }`}
          aria-label="Conversation"
        >
          {selected && conversation ? (
            <>
              <div className="border-b border-edge px-6 pt-[18px] pb-2.5">
                <h2 data-testid="conversation-subject" className="text-[17px] font-semibold">
                  {conversation.subject}
                </h2>
              </div>
              <div className="flex flex-col gap-3 px-6 pt-3 pb-8">
                {conversation.messages.map((m) => (
                  <article
                    key={m.id}
                    data-testid="message-card"
                    className="rounded-[10px] border border-edge bg-raised px-4 py-3.5"
                  >
                    <div className="mb-2.5 flex items-baseline gap-2">
                      <span className="font-semibold">{m.fromName}</span>
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-faint">
                        &lt;{m.fromEmail}&gt;
                      </span>
                      <span className="flex-none text-xs text-ink-faint">{m.at}</span>
                    </div>
                    {/* Mail bodies are untrusted input: render ONLY as a text
                        node. Sanitized HTML rendering is a later milestone. */}
                    <div className="whitespace-pre-wrap leading-[1.55] text-ink [overflow-wrap:break-word]">
                      {m.text}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-ink-faint">
              {selected ? 'Loading…' : 'Nothing selected'}
            </div>
          )}
        </section>
      </main>

      <footer className="flex items-center gap-4 border-t border-edge px-4 py-[7px] text-xs text-ink-faint">
        <span>
          <Kbd>J</Kbd>/<Kbd>K</Kbd> navigate
        </span>
        <span>
          <Kbd>Enter</Kbd> open
        </span>
        <span>
          <Kbd>Esc</Kbd> back
        </span>
        <span
          data-testid="status-note"
          className={`ml-auto ${sync.phase === 'error' ? 'text-danger' : ''}`}
          title={statusNote}
        >
          {statusNote}
        </span>
      </footer>
    </div>
  )
}
