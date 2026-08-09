import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mockThreads, getConversation as getMockConversation } from './mockData'
import type { AuthStatus } from '../../shared/auth'
import type { Conversation, SyncState, ThreadRow } from '../../shared/mail'

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
    window.shc?.auth
      .signIn()
      .then(onStatus)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'sign-in failed'
        // A canceled flow means the user retried — the new attempt owns the UI.
        if (!msg.includes('sign-in canceled')) setError(msg)
      })
      .finally(() => setBusy(false))
  }, [onStatus])

  if (!window.shc) return <div className="account-chip">mock data · browser preview</div>
  if (!status) return <div className="account-chip">…</div>
  if (status.signedIn) return <div className="account-chip">{status.email ?? 'signed in'}</div>
  if (!status.configured) {
    return (
      <div
        className="account-chip"
        title="Create your Google OAuth client, then add oauth.config.json — see SETUP.md"
      >
        OAuth not configured · see SETUP.md
      </div>
    )
  }
  if (busy) return <div className="account-chip">waiting for Google…</div>
  return (
    <button className="account-chip chip-button" onClick={signIn} title={error ?? undefined}>
      {error ? 'sign-in failed — retry' : 'Sign in with Google'}
    </button>
  )
}

export default function App(): React.JSX.Element {
  const shc = window.shc
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusRegion, setFocusRegion] = useState<FocusRegion>('list')
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set())
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const convCache = useRef(new Map<string, DisplayConversation>())

  const realMode = Boolean(shc && status?.signedIn)

  useEffect(() => {
    shc?.auth
      .getStatus()
      .then(setStatus)
      .catch(() => {})
  }, [shc])

  useEffect(() => {
    if (!shc) return
    shc.sync.getState().then(setSync).catch(() => {})
    const offSync = shc.sync.onState(setSync)
    const offMail = shc.mail.onChanged(() => {
      convCache.current.clear()
      shc.mail.listThreads().then(setRealThreads).catch(() => {})
    })
    return () => {
      offSync()
      offMail()
    }
  }, [shc])

  useEffect(() => {
    if (realMode) shc!.mail.listThreads().then(setRealThreads).catch(() => {})
  }, [realMode, shc])

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
    let cancelled = false
    setConversation(null)
    shc!.mail
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
  }, [selected?.id, realMode, shc])

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
    <div className="app">
      <header className="topbar">
        <div className="splits">
          <button className="split active">
            Important <span className="count">{unreadCount}</span>
          </button>
          <button className="split" disabled title="Split inbox lands at M3 (F11)">
            Other
          </button>
        </div>
        <AccountChip status={status} onStatus={setStatus} />
      </header>

      <main className="panes">
        <section className={`thread-list ${focusRegion === 'list' ? 'focused' : ''}`} aria-label="Conversation list">
          {threads.length === 0 && (
            <div className="list-empty">
              {sync.phase === 'syncing' ? 'Syncing your inbox…' : 'Inbox empty'}
            </div>
          )}
          {threads.map((t, i) => {
            const isSelected = i === selectedIndex
            const isUnread = t.unread && !readIds.has(t.id)
            return (
              <div
                key={t.id}
                ref={isSelected ? selectedRowRef : null}
                className={`row ${isSelected ? 'selected' : ''} ${isUnread ? 'unread' : ''}`}
                onClick={() => setSelectedIndex(i)}
                onDoubleClick={() => openConversation(t.id)}
              >
                <span className="row-dot" aria-hidden />
                <span className="row-from">{t.from}</span>
                <span className="row-main">
                  <span className="row-subject">{t.subject}</span>
                  <span className="row-snippet"> — {t.snippet}</span>
                </span>
                <span className="row-meta">
                  {t.hasAttachment && <span title="Has attachment">📎</span>}
                  {t.starred && <span title="Starred">★</span>}
                  <span className="row-time">{t.at}</span>
                </span>
              </div>
            )
          })}
        </section>

        <section
          className={`reading-pane ${focusRegion === 'conversation' ? 'focused' : ''}`}
          aria-label="Conversation"
        >
          {selected && conversation ? (
            <>
              <div className="conv-header">
                <h2>{conversation.subject}</h2>
              </div>
              <div className="conv-messages">
                {conversation.messages.map((m) => (
                  <article key={m.id} className="message">
                    <div className="message-head">
                      <span className="message-from">{m.fromName}</span>
                      <span className="message-email">&lt;{m.fromEmail}&gt;</span>
                      <span className="message-at">{m.at}</span>
                    </div>
                    {/* Mail bodies are untrusted input: render ONLY as a text
                        node. Sanitized HTML rendering is a later milestone. */}
                    <div className="message-body message-text">{m.text}</div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="pane-empty">{selected ? 'Loading…' : 'Nothing selected'}</div>
          )}
        </section>
      </main>

      <footer className="hintbar">
        <span>
          <kbd>J</kbd>/<kbd>K</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> back
        </span>
        <span className={`hint-right ${sync.phase === 'error' ? 'hint-error' : ''}`} title={statusNote}>
          {statusNote}
        </span>
      </footer>
    </div>
  )
}
