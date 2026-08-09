import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mockThreads, getConversation } from './mockData'
import type { AuthStatus } from '../../shared/auth'

type FocusRegion = 'list' | 'conversation'

function AccountChip(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.shc?.auth
      .getStatus()
      .then(setStatus)
      .catch(() => {})
  }, [])

  const signIn = useCallback(() => {
    setBusy(true)
    setError(null)
    window.shc?.auth
      .signIn()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'sign-in failed'))
      .finally(() => setBusy(false))
  }, [])

  if (!window.shc) return <div className="account-chip">mock data · browser preview</div>
  if (!status) return <div className="account-chip">…</div>
  if (status.signedIn) return <div className="account-chip">{status.email ?? 'signed in'}</div>
  if (!status.configured) {
    return (
      <div className="account-chip" title="Create your Google OAuth client, then add oauth.config.json — see SETUP.md">
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
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusRegion, setFocusRegion] = useState<FocusRegion>('list')
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)

  const selected = mockThreads[selectedIndex]
  const conversation = useMemo(() => getConversation(selected.id), [selected.id])

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
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, mockThreads.length - 1))
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          openConversation(mockThreads[selectedIndex].id)
          break
        case 'Escape':
          e.preventDefault()
          setFocusRegion('list')
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedIndex, openConversation])

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="app">
      <header className="topbar">
        <div className="splits">
          <button className="split active">
            Important <span className="count">{mockThreads.filter((t) => t.unread && !readIds.has(t.id)).length}</span>
          </button>
          <button className="split" disabled title="Split inbox lands at M3 (F11)">
            Other
          </button>
        </div>
        <AccountChip />
      </header>

      <main className="panes">
        <section className={`thread-list ${focusRegion === 'list' ? 'focused' : ''}`} aria-label="Conversation list">
          {mockThreads.map((t, i) => {
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
                <div className="message-body">
                  {m.body.map((p, idx) => (
                    <p key={idx}>{p}</p>
                  ))}
                </div>
              </article>
            ))}
          </div>
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
        <span className="hint-right">M0 walking skeleton · mock data</span>
      </footer>
    </div>
  )
}
