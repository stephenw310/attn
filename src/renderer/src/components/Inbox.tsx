import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/auth'
import type {
  Conversation,
  MailAddress,
  MailLabel,
  MessageAttachment,
  MessageRecipients,
  SnoozedThreadRow,
  SyncStage,
  SyncState,
  ThreadRow
} from '../../../shared/mail'
import { formatSnoozeDate, parseSnoozeText, snoozePresets } from '../../../shared/snooze'
import { createCommand, registerCommands } from '../commands'
import { useConversation } from '../hooks/useConversation'
import { useInboxCommands } from '../hooks/useInboxCommands'
import { useKeyboardDispatch } from '../hooks/useKeyboardDispatch'
import { useMailData } from '../hooks/useMailData'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { useSelectionState } from '../hooks/useSelectionState'
import { useSyncActions } from '../hooks/useSyncActions'
import { useToast } from '../hooks/useToast'
import { useTriage } from '../hooks/useTriage'
import { type LabelCheckState, LabelPicker } from '../LabelPicker'
import { MessageBody } from '../MessageBody'
import { ConversationView } from './ConversationView'
import { MailHeader } from './MailHeader'
import { ThreadList } from './ThreadList'
import { Toast } from './Toast'

export interface DisplayThread {
  id: string
  from: string
  subject: string
  snippet: string
  at: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
  returned: boolean
  dueAt?: number
  dueLabel?: string
  labelIds: string[]
  lastMsgAt: number
}

interface DisplayMsg {
  id: string
  fromName: string
  fromEmail: string
  at: string
  fullDate: string
  recipients: MessageRecipients
  attachments: MessageAttachment[]
  text: string
  html: string | null
}

export interface DisplayConversation {
  threadId: string
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

function formatFullDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  })
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
    hasAttachment: r.hasAttachment,
    returned: r.returned,
    labelIds: r.labelIds,
    lastMsgAt: r.lastMsgAt
  }
}

function fromSnoozedThreadRow(r: SnoozedThreadRow): DisplayThread {
  return { ...fromThreadRow(r), dueAt: r.dueAt, dueLabel: formatSnoozeDate(r.dueAt) }
}

function displayFromReal(c: Conversation): DisplayConversation {
  return {
    threadId: c.threadId,
    subject: c.subject,
    messages: c.messages.map((m) => ({
      id: m.id,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      at: formatTime(m.at),
      fullDate: formatFullDate(m.at),
      recipients: m.recipients,
      attachments: m.attachments,
      text: m.bodyText,
      html: m.bodyHtml
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

interface ShortcutHint {
  id: string
  keys: string[]
  label: string
}

const TRIAGE_SHORTCUT_HINTS: ShortcutHint[] = [
  { id: 'done', keys: ['E'], label: 'done' },
  { id: 'snooze', keys: ['H'], label: 'snooze' },
  { id: 'label', keys: ['L'], label: 'label' },
  { id: 'trash', keys: ['#'], label: 'trash' },
  { id: 'star', keys: ['S'], label: 'star' },
  { id: 'unread', keys: ['U'], label: 'unread' },
  { id: 'spam', keys: ['!'], label: 'spam' },
  { id: 'undo', keys: ['Z'], label: 'undo' }
]

function footerShortcuts(readerOpen: boolean): ShortcutHint[] {
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
    ...TRIAGE_SHORTCUT_HINTS
  ]
}

function FooterShortcut({ id, keys, label }: ShortcutHint): React.JSX.Element {
  return (
    <span
      data-testid={`footer-shortcut-${id}`}
      className="flex items-center gap-1.5 whitespace-nowrap text-ink-dim"
    >
      <span className="flex items-center gap-0.5">
        {keys.map((key, index) => (
          <span key={key} className="contents">
            {index > 0 && <span aria-hidden>/</span>}
            <Kbd>{key}</Kbd>
          </span>
        ))}
      </span>
      {label}
    </span>
  )
}

function firstName(address: MailAddress, account: string | null): string {
  if (account && address.email.toLowerCase() === account.toLowerCase()) return 'me'
  if (address.name.toLowerCase() === 'me' || address.email.toLowerCase() === 'you') return 'me'
  return address.name.trim().split(/\s+/)[0] || address.email
}

function fullAddress(address: MailAddress): string {
  if (!address.name || address.name === address.email) return address.email
  return `${address.name} <${address.email}>`
}

function recipientSummary(recipients: MessageRecipients, account: string | null): string {
  const to = recipients.to.map((address) => firstName(address, account))
  const cc = recipients.cc.map((address) => firstName(address, account))
  const parts = [`to ${to.length > 0 ? to.join(', ') : 'undisclosed recipients'}`]
  if (cc.length > 0) parts.push(`cc ${cc.join(', ')}`)
  return parts.join(' · ')
}

function RecipientLine({
  message,
  account
}: {
  message: DisplayMsg
  account: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const groups: { label: string; addresses: MailAddress[] }[] = [
    { label: 'From', addresses: [{ name: message.fromName, email: message.fromEmail }] },
    { label: 'To', addresses: message.recipients.to },
    { label: 'Cc', addresses: message.recipients.cc },
    { label: 'Bcc', addresses: message.recipients.bcc },
    { label: 'Reply-To', addresses: message.recipients.replyTo }
  ]

  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="recipient-summary"
        aria-expanded={open}
        onClick={(event) => {
          setOpen((value) => !value)
          event.currentTarget.blur()
        }}
        className="block max-w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-left text-xs text-ink-faint hover:text-ink-dim"
      >
        {recipientSummary(message.recipients, account)} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          data-testid="recipient-details"
          className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-edge bg-active/60 p-3 text-xs text-ink-faint"
        >
          {groups
            .filter((group) => group.addresses.length > 0)
            .map((group) => (
              <div key={group.label} className="contents">
                <span className="font-medium text-ink-dim">{group.label}</span>
                <span className="min-w-0 break-words">{group.addresses.map(fullAddress).join(', ')}</span>
              </div>
            ))}
          <span className="font-medium text-ink-dim">Date</span>
          <span>{message.fullDate}</span>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function MessageCard({
  message,
  account,
  onToast,
  collapsed = false,
  onToggleCollapsed,
  trimExpanded = false,
  onToggleTrim
}: {
  message: DisplayMsg
  account: string | null
  onToast: (message: string) => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
  trimExpanded?: boolean
  onToggleTrim: () => void
}): React.JSX.Element {
  const htmlSurface = message.html !== null

  const download = useCallback(
    (attachment: MessageAttachment) => {
      if (!attn) {
        onToast('Attachments download when signed in')
        return
      }
      void attn.mail
        .downloadAttachment({
          messageId: message.id,
          attachmentId: attachment.attachmentId,
          filename: attachment.filename
        })
        .then((result) => {
          if ('error' in result) onToast(result.error)
        })
        .catch(() => onToast('Could not download attachment'))
    },
    [message.id, onToast]
  )

  if (collapsed) {
    return (
      <article
        data-testid="message-card"
        data-collapsed="true"
        className="rounded-[10px] border border-edge bg-ground"
      >
        <button
          type="button"
          data-testid="older-message-toggle"
          aria-expanded="false"
          aria-label={`Expand older message from ${message.fromName}`}
          onClick={(event) => {
            onToggleCollapsed?.()
            event.currentTarget.blur()
          }}
          className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-5 py-3 text-left hover:bg-active/50"
        >
          <span className="min-w-0 font-semibold">{message.fromName}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-faint">
            {message.text || 'HTML message'}
          </span>
          <span className="flex items-center gap-2 text-xs text-ink-faint tabular-nums">
            {message.attachments.length > 0 && <span title="Has attachment">📎</span>}
            {message.at}
            <span aria-hidden>▾</span>
          </span>
        </button>
      </article>
    )
  }

  return (
    <article
      data-testid="message-card"
      data-collapsed="false"
      className="rounded-[10px] border border-edge bg-ground px-5 py-4"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: message keyboard control is app-level; this mirrors the summary row's pointer target */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: nested recipient controls must remain independently interactive */}
      <div
        data-testid="message-header"
        className="mb-3 grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5"
        onClick={(event) => {
          const target = event.target
          if (target instanceof Element && target.closest('button, a')) return
          onToggleCollapsed?.()
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className="font-semibold">{message.fromName}</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-faint">
              &lt;{message.fromEmail}&gt;
            </span>
          </div>
        </div>
        <span className="flex flex-none items-center gap-2 text-xs text-ink-faint tabular-nums">
          {message.at}
          {onToggleCollapsed && (
            <button
              type="button"
              data-testid="older-message-toggle"
              aria-expanded="true"
              aria-label={`Collapse older message from ${message.fromName}`}
              onClick={(event) => {
                onToggleCollapsed()
                event.currentTarget.blur()
              }}
              className="cursor-pointer rounded px-1 text-ink-faint hover:bg-active hover:text-ink-dim"
            >
              <span aria-hidden>▴</span>
            </button>
          )}
        </span>
        <div className="col-span-2 min-w-0">
          <RecipientLine message={message} account={account} />
        </div>
      </div>
      <div
        data-testid="message-content"
        className={`min-w-0 ${htmlSurface ? 'overflow-hidden bg-white' : ''}`}
      >
        <MessageBody
          bodyText={message.text}
          bodyHtml={message.html}
          messageId={message.id}
          attachments={message.attachments}
          expanded={trimExpanded}
          onToggleTrim={onToggleTrim}
        />
        {message.attachments.length > 0 && (
          <div data-testid="message-accessories" className={htmlSurface ? 'bg-white px-3 pb-3' : ''}>
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <button
                  key={attachment.attachmentId}
                  type="button"
                  data-testid="attachment-chip"
                  onClick={(event) => {
                    download(attachment)
                    event.currentTarget.blur()
                  }}
                  className={`cursor-pointer rounded-lg border px-3 py-2 text-left text-xs ${
                    htmlSurface
                      ? 'border-[#d1d5db] bg-[#f3f4f6] text-[#4b5563] hover:border-[#9ca3af] hover:text-[#202124]'
                      : 'border-edge bg-active text-ink-dim hover:border-accent hover:text-ink'
                  }`}
                  title={`Download ${attachment.filename}`}
                >
                  <span className="mr-2" aria-hidden>
                    📎
                  </span>
                  <span className="font-medium">{attachment.filename}</span>
                  <span className={`ml-2 tabular-nums ${htmlSurface ? 'text-[#6b7280]' : 'text-ink-faint'}`}>
                    {formatBytes(attachment.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

function ConversationMessages({
  conversation,
  account,
  onToast
}: {
  conversation: DisplayConversation
  account: string | null
  onToast: (message: string) => void
}): React.JSX.Element {
  const newestIndex = conversation.messages.length - 1
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => {
    const newestMessage = conversation.messages[newestIndex]
    return new Set(newestMessage ? [newestMessage.id] : [])
  })
  const [expandedTrimIds, setExpandedTrimIds] = useState<Set<string>>(() => new Set())

  const toggleMessage = useCallback((messageId: string) => {
    setExpandedMessageIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  const toggleTrim = useCallback((messageId: string) => {
    setExpandedTrimIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const newestMessage = conversation.messages[newestIndex]
    if (!newestMessage) return
    return registerCommands([createCommand('message.trim.toggle', () => toggleTrim(newestMessage.id))])
  }, [conversation.messages, newestIndex, toggleTrim])

  return (
    <>
      {conversation.messages.map((message) => {
        return (
          <MessageCard
            key={message.id}
            message={message}
            account={account}
            onToast={onToast}
            collapsed={!expandedMessageIds.has(message.id)}
            onToggleCollapsed={() => toggleMessage(message.id)}
            trimExpanded={expandedTrimIds.has(message.id)}
            onToggleTrim={() => toggleTrim(message.id)}
          />
        )
      })}
    </>
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

const SYNC_STAGES: SyncStage[] = ['metadata', 'bodies', 'reconcile']

function syncStageLabel(stage: SyncStage): string {
  if (stage === 'metadata') return 'Message list'
  if (stage === 'bodies') return 'Recent mail'
  return 'Finishing up'
}

function SyncProgress({ stage }: { stage: SyncStage }): React.JSX.Element {
  const activeIndex = SYNC_STAGES.indexOf(stage)
  return (
    <span
      data-testid="sync-progress"
      role="progressbar"
      aria-label={`Sync phase ${activeIndex + 1} of ${SYNC_STAGES.length}: ${syncStageLabel(stage)}`}
      aria-valuemin={1}
      aria-valuemax={SYNC_STAGES.length}
      aria-valuenow={activeIndex + 1}
      className="col-start-2 grid h-[3px] w-44 grid-cols-3 gap-[3px] overflow-hidden"
    >
      {SYNC_STAGES.map((item, index) => (
        <i
          key={item}
          data-phase-state={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending'}
          className="app-sync-phase-segment overflow-hidden rounded-full bg-edge"
        />
      ))}
    </span>
  )
}

function SyncStatus({
  sync,
  networkOnline,
  onRetry,
  onCopyError
}: {
  sync: SyncState
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const displayState =
    sync.phase === 'error'
      ? 'error'
      : sync.phase === 'offline' || !networkOnline
        ? 'offline'
        : sync.phase === 'idle'
          ? 'live'
          : sync.phase === 'checking'
            ? 'checking'
            : 'syncing'
  const syncingStage = sync.phase === 'syncing' ? sync.stage : 'metadata'

  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
    blurActive()
  }, [])

  useEffect(() => {
    if (sync.phase !== 'error') setDetailsOpen(false)
  }, [sync.phase])

  useEffect(() => {
    if (!detailsOpen) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeDetails()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeDetails()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeDetails, detailsOpen])

  const label =
    displayState === 'live'
      ? 'Live'
      : displayState === 'offline'
        ? 'Offline'
        : displayState === 'error'
          ? 'Error'
          : displayState === 'checking'
            ? 'Checking mail'
            : `Syncing · ${syncStageLabel(syncingStage)}`
  const detail =
    displayState === 'live'
      ? 'Up to date'
      : displayState === 'offline'
        ? 'Local mail available'
        : displayState === 'error'
          ? 'Click for details'
          : displayState === 'checking'
            ? 'Looking for new mail'
            : null
  const title =
    displayState === 'error' && sync.phase === 'error'
      ? sync.message
      : displayState === 'offline' && sync.phase === 'offline'
        ? sync.message
        : displayState === 'syncing' && sync.phase === 'syncing'
          ? `${label} — ${sync.threadsDone} processed`
          : `${label} — ${detail}`

  const body = (
    <>
      <span className="app-status-dot row-start-1 size-[7px] rounded-full" aria-hidden />
      <span
        className={`row-start-1 whitespace-nowrap text-[11.5px] font-semibold ${
          displayState === 'error' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        {label}
      </span>
      {displayState === 'syncing' && sync.phase === 'syncing' ? (
        <SyncProgress stage={sync.stage} />
      ) : (
        <span className="col-start-2 row-start-2 text-[9.5px] leading-[10px] text-ink-faint">{detail}</span>
      )}
    </>
  )

  return (
    <div
      ref={wrapRef}
      data-testid="status-note"
      data-status={displayState}
      className="relative ml-auto flex w-[196px] flex-none justify-end"
      title={title}
      aria-live="polite"
    >
      {displayState === 'error' && sync.phase === 'error' ? (
        <button
          type="button"
          data-testid="status-error-button"
          className="grid w-fit cursor-pointer grid-cols-[7px_auto] grid-rows-[17px_10px] items-center gap-x-2 text-left"
          aria-expanded={detailsOpen}
          aria-controls="sync-error-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {body}
        </button>
      ) : (
        <div
          data-testid="status-content"
          className="grid w-fit grid-cols-[7px_auto] grid-rows-[17px_10px] items-center gap-x-2"
        >
          {body}
        </div>
      )}

      {detailsOpen && sync.phase === 'error' && (
        <div
          id="sync-error-details"
          data-testid="status-error-details"
          role="dialog"
          aria-label="Sync error details"
          className="absolute right-0 bottom-full z-50 mb-2 w-[330px] rounded-[10px] border border-edge bg-raised p-3.5 text-left shadow-[0_15px_42px_rgba(0,0,0,0.58)]"
        >
          <div className="flex items-center gap-2 text-xs font-bold text-ink">
            <span className="text-danger" aria-hidden>
              ●
            </span>
            Gmail sync error
          </div>
          <p
            data-testid="status-error-message"
            className="my-2 max-h-48 overflow-y-auto break-words text-[11px] leading-[1.45] text-ink-dim"
          >
            {sync.message}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="status-retry"
              className="cursor-pointer rounded-md border border-edge bg-active px-2.5 py-1.5 text-[10.5px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
              onClick={() => {
                setDetailsOpen(false)
                onRetry()
              }}
            >
              Retry now
            </button>
            <button
              type="button"
              data-testid="status-copy-error"
              className="cursor-pointer rounded-md border border-edge bg-active px-2.5 py-1.5 text-[10.5px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
              onClick={() => onCopyError(sync.message)}
            >
              Copy details
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function blurActive(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) el.blur()
}

export function LoginScreen({
  status,
  statusError,
  onRetryStatus,
  onStatus
}: {
  status: AuthStatus | null
  statusError: string | null
  onRetryStatus: () => void
  onStatus: (status: AuthStatus) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const configured = status?.configured === true
  const bridgeAvailable = Boolean(attn)

  const signIn = useCallback(() => {
    if (!attn || !configured) return
    setBusy(true)
    setError(null)
    attn.auth
      .signIn()
      .then(onStatus)
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : 'Could not sign in'
        if (!message.includes('sign-in canceled')) setError(message)
      })
      .finally(() => setBusy(false))
  }, [configured, onStatus])

  const setupMessage = !bridgeAvailable
    ? 'Open Attn as a desktop app to continue.'
    : statusError !== null
      ? `Could not check sign-in status. ${statusError}`
      : status === null
        ? 'Checking sign-in availability…'
        : !configured
          ? 'This development build needs a Google OAuth client. Follow the setup steps in README.md, then restart Attn.'
          : null

  return (
    <div
      data-testid="login-screen"
      className="app-drag relative flex h-full flex-col overflow-hidden bg-ground"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            'radial-gradient(circle at 50% 38%, rgba(255, 178, 36, 0.11), transparent 29%), radial-gradient(circle at 12% 100%, rgba(72, 82, 112, 0.13), transparent 34%)'
        }}
      />
      <header className="relative flex items-center px-7 py-5">
        <div className="text-base font-bold tracking-tight">
          attn<span className="text-accent">:</span>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 items-center justify-center px-6 pb-14">
        <section className="app-no-drag w-full max-w-[430px] text-center">
          <div className="mx-auto mb-7 flex size-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent/[0.08] text-accent shadow-[0_18px_60px_rgba(0,0,0,0.32)]">
            <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none">
              <title>Mail</title>
              <path
                d="M4 7.5 12 13l8-5.5M5.5 18h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18.5 6h-13A1.5 1.5 0 0 0 4 7.5v9A1.5 1.5 0 0 0 5.5 18Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-accent uppercase">
            Your inbox, in focus
          </p>
          <h1 className="text-[32px] font-semibold tracking-[-0.035em] text-ink">
            Make space for what matters.
          </h1>
          <p className="mx-auto mt-4 max-w-[390px] text-sm leading-6 text-ink-dim">
            Sign in with Google to bring your Gmail into a fast, keyboard-first inbox that keeps its local
            copy on this device.
          </p>

          {/* Keyboard-first: the screen's only action answers Enter on arrival, so
              signing in never needs a Tab first. Disabled while unconfigured, which
              is exactly when there is nothing to activate. */}
          <button
            type="button"
            data-testid="login-google"
            // biome-ignore lint/a11y/noAutofocus: sole action on a dedicated screen
            autoFocus
            disabled={!configured || busy || !bridgeAvailable}
            onClick={signIn}
            className="mt-8 flex h-12 w-full cursor-pointer items-center justify-center gap-3 rounded-[9px] border border-white/15 bg-[#f3f4f7] px-5 text-sm font-semibold text-[#202124] shadow-[0_10px_30px_rgba(0,0,0,0.28)] transition hover:bg-white disabled:cursor-default disabled:opacity-45"
          >
            <span className="flex size-5 items-center justify-center rounded-full border border-[#dadce0] bg-white text-[12px] font-bold text-[#4285f4]">
              G
            </span>
            {busy ? 'Waiting for Google…' : 'Continue with Google'}
          </button>

          <div className="mt-4 min-h-10 text-xs leading-5 text-ink-faint" aria-live="polite">
            {error ? (
              <span data-testid="login-error" className="text-danger">
                Sign-in failed. {error}
              </span>
            ) : (
              setupMessage && <span data-testid="login-setup-message">{setupMessage}</span>
            )}
            {statusError !== null && (
              <button
                type="button"
                data-testid="login-status-retry"
                onClick={onRetryStatus}
                className="ml-1.5 cursor-pointer underline underline-offset-2 hover:text-ink-dim"
              >
                Try again
              </button>
            )}
          </div>

          <div className="mt-7 flex items-center justify-center gap-3 text-[11px] text-ink-faint">
            <span>Local-first</span>
            <span className="text-edge">•</span>
            <span>Keyboard-first</span>
            <span className="text-edge">•</span>
            <span>Private by design</span>
          </div>
        </section>
      </main>
    </div>
  )
}

function AccountMenu({
  status,
  onStatus
}: {
  status: AuthStatus
  onStatus: (s: AuthStatus) => void
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

function SnoozePicker({
  targetCount,
  onCancel,
  onConfirm,
  onUnsnooze
}: {
  targetCount: number
  onCancel: () => void
  onConfirm: (dueAt: number) => void
  onUnsnooze?: () => void
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const dialogRef = useRef<HTMLElement | null>(null)
  const presets = useMemo(() => snoozePresets(), [])
  const parsedCustom = useMemo(() => parseSnoozeText(custom), [custom])
  const customDueAt = parsedCustom !== null && parsedCustom > Date.now() ? parsedCustom : null
  const optionCount = presets.length + (onUnsnooze ? 1 : 0)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const runActiveOption = (): void => {
    const preset = presets[activeIndex]
    if (preset) onConfirm(preset.dueAt)
    else if (onUnsnooze) onUnsnooze()
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the app-level picker guard */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is the pointer dismissal path */}
      <div className="fixed inset-0 z-50 bg-[rgba(8,9,11,0.72)]" onClick={onCancel} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="snooze-title"
        data-testid="snooze-picker"
        tabIndex={-1}
        className="fixed top-1/2 left-1/2 z-[60] w-[min(430px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-edge bg-raised p-3 shadow-[0_24px_64px_rgba(0,0,0,0.65)] focus:outline-none"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.currentTarget.focus()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((index) => (index + direction + optionCount) % optionCount)
            return
          }
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault()
            runActiveOption()
          }
        }}
      >
        <div className="px-2 pt-1 pb-2">
          <h2 id="snooze-title" className="text-base font-semibold">
            Remind me later
          </h2>
          <p data-testid="snooze-subtitle" className="mt-0.5 text-xs text-ink-faint">
            {targetCount > 1
              ? `Choose when these ${targetCount} conversations return.`
              : 'Choose when this conversation returns.'}
          </p>
        </div>
        <div className="flex flex-col gap-0.5">
          {presets.map((preset, index) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`snooze-preset-${preset.id}`}
              data-active={activeIndex === index || undefined}
              tabIndex={-1}
              className={`flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${
                activeIndex === index ? 'bg-active text-ink' : ''
              }`}
              onClick={() => onConfirm(preset.dueAt)}
              onMouseMove={() => setActiveIndex(index)}
            >
              <span>{preset.label}</span>
              <span className="text-xs text-ink-faint">{formatSnoozeDate(preset.dueAt)}</span>
            </button>
          ))}
        </div>
        {onUnsnooze && (
          <div className="mt-2 border-t border-edge pt-2">
            <button
              type="button"
              data-testid="snooze-unsnooze"
              data-active={activeIndex === presets.length || undefined}
              tabIndex={-1}
              className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm ${
                activeIndex === presets.length ? 'bg-active text-ink' : ''
              }`}
              onClick={onUnsnooze}
              onMouseMove={() => setActiveIndex(presets.length)}
            >
              <span>Unsnooze</span>
              <span className="text-xs text-ink-faint">Return to inbox now</span>
            </button>
          </div>
        )}
        <div className="mt-2 border-t border-edge px-2 pt-3 pb-1">
          <label htmlFor="snooze-custom" className="text-xs font-medium text-ink-dim">
            Custom time
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="snooze-custom"
              data-testid="snooze-input"
              value={custom}
              placeholder="thu 2pm or in 3 days"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-ground px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancel()
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  if (customDueAt !== null) onConfirm(customDueAt)
                }
              }}
            />
            <button
              type="button"
              data-testid="snooze-custom-confirm"
              disabled={customDueAt === null}
              className="cursor-pointer rounded-lg bg-accent px-3 text-sm font-semibold text-ground disabled:cursor-default disabled:opacity-35"
              onClick={() => customDueAt !== null && onConfirm(customDueAt)}
            >
              Snooze
            </button>
          </div>
          <div data-testid="snooze-resolved" className="mt-1.5 min-h-4 text-xs text-ink-faint">
            {parsedCustom !== null &&
              (customDueAt !== null ? formatSnoozeDate(customDueAt) : 'Choose a future time')}
          </div>
        </div>
      </section>
    </>
  )
}

// The preload bridge is injected before renderer modules evaluate, so this is
// safe to read once at module scope (undefined in the plain-browser preview).
const attn = window.attn

export function Inbox({
  status,
  onStatus
}: {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
}): React.JSX.Element {
  const [view, setView] = useState<'inbox' | 'snoozed'>('inbox')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null)
  const [toast, showToast] = useToast()
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const selectedThreadIdRef = useRef<string | null>(null)
  const activeViewRef = useRef<'inbox' | 'snoozed'>('inbox')
  const earliestExitIndexRef = useRef<number | null>(null)

  const activeAccount = status.email ?? null
  const {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    realUnreadTotal,
    labels,
    pendingCount,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  } = useMailData(activeAccount, activeViewRef, selectedThreadIdRef, setSelectedIndex)
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])

  useEffect(() => {
    void activeAccount
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
    setExitingThreadIds(new Set())
    selectedThreadIdRef.current = null
  }, [activeAccount])

  const threads: DisplayThread[] = useMemo(
    () =>
      view === 'inbox'
        ? (realThreads ?? []).map(fromThreadRow)
        : (realSnoozedThreads ?? []).map(fromSnoozedThreadRow),
    [realSnoozedThreads, realThreads, view]
  )
  const { selectedIds, clearSelection, resetSelection, toggleFocusedSelection, extendSelectionTo } =
    useSelectionState(threads, selectedIndex, setSelectedIndex)

  useEffect(() => {
    void activeAccount
    resetSelection()
  }, [activeAccount, resetSelection])

  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(threads.length - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    if (threads.length === 0) setReaderOpen(false)
  }, [threads])

  const selected: DisplayThread | undefined = threads[selectedIndex]
  const { conversation, scrollRef: conversationScrollRef } = useConversation(
    selected,
    selectedIndex,
    threads,
    readerOpen,
    activeAccount,
    displayFromReal
  )
  const targetedThreads =
    selectedIds.size > 0 ? threads.filter((thread) => selectedIds.has(thread.id)) : selected ? [selected] : []
  const starOn = targetedThreads.some((thread) => !thread.starred)
  const markUnreadOn = targetedThreads.some((thread) => !thread.unread)

  // The label picker targets a thread by id, not by list position: a refresh can
  // reorder or drop rows underneath an open picker, and applying the label to
  // whatever now sits at the old index would silently label the wrong thread.
  const labelTarget = useMemo(
    () => (labelTargetId === null ? undefined : threads.find((t) => t.id === labelTargetId)),
    [labelTargetId, threads]
  )

  useEffect(() => {
    if (labelTargetId !== null && !labelTarget) setLabelTargetId(null)
  }, [labelTarget, labelTargetId])

  useEffect(() => {
    selectedThreadIdRef.current = selected?.id ?? null
  }, [selected?.id])

  const { retrySync, copySyncError } = useSyncActions(sync, showToast)

  const switchView = useCallback((next: 'inbox' | 'snoozed') => {
    activeViewRef.current = next
    selectedThreadIdRef.current = null
    setView(next)
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
  }, [])

  useEffect(() => {
    if (!attn || !activeAccount) return
    return attn.mail.onFocusThread((threadId) => {
      // Close the old reader before changing lists. Otherwise the auto-read
      // effect can observe the old cursor against Inbox and mutate the wrong thread.
      switchView('inbox')
      clearSelection()
      void attn.mail
        .listThreads()
        .then((nextThreads) => {
          const nextIndex = nextThreads.findIndex((thread) => thread.id === threadId)
          setRealThreads(nextThreads)
          if (nextIndex < 0) return
          selectedThreadIdRef.current = threadId
          setSelectedIndex(nextIndex)
          setReaderOpen(true)
        })
        .catch(() => {})
    })
  }, [activeAccount, clearSelection, setRealThreads, switchView])

  const triage = useTriage({
    selectedIds,
    selectedIndex,
    threadCount: threads.length,
    readerOpen,
    view,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef,
    earliestExitIndexRef,
    clearSelection,
    showToast,
    setExitingThreadIds,
    setSelectedIndex
  })

  const toggleLabel = useCallback(
    (label: MailLabel, state: LabelCheckState) => {
      if (!labelTarget) return
      triage({
        kind: 'label',
        threadIds: [labelTarget.id],
        add: state === 'all' ? [] : [label.id],
        remove: state === 'all' ? [label.id] : []
      })
    },
    [labelTarget, triage]
  )

  const openSelected = useCallback(() => {
    const thread = threads[selectedIndex]
    if (!thread) return
    setReaderOpen(true)
  }, [selectedIndex, threads])

  const closeReader = useCallback(() => setReaderOpen(false), [])

  const snoozeSelected = useCallback(
    (dueAt: number) => {
      if (!attn || !selected) return
      const isBulk = selectedIds.size > 0
      const threadIds = isBulk ? [...selectedIds] : [selected.id]
      setSnoozeOpen(false)
      if (isBulk) clearSelection()
      void attn.mail
        .snooze(threadIds, dueAt)
        .then((result) => showToast(result.label))
        .catch(() => {})
    },
    [clearSelection, selected, selectedIds, showToast]
  )

  const unsnoozeSelected = useCallback(() => {
    if (!selected) return
    setSnoozeOpen(false)
    triage({ kind: 'unsnooze', threadIds: [selected.id] })
  }, [selected, triage])

  useInboxCommands({
    threadCount: threads.length,
    selected,
    selectedCount: selectedIds.size,
    selectedIndex,
    readerOpen,
    view,
    starOn,
    markUnreadOn,
    preserveSelectionOnRefreshRef,
    setSelectedIndex,
    clearSelection,
    toggleSelection: toggleFocusedSelection,
    extendSelection: extendSelectionTo,
    openSelected,
    closeReader,
    switchView,
    triage,
    openSnooze: () => selected && setSnoozeOpen(true),
    openLabel: () => selected && setLabelTargetId(selected.id),
    showToast
  })

  useKeyboardDispatch({
    blocked: labelTarget !== undefined,
    readerOpen,
    snoozeOpen,
    onCloseSnooze: () => setSnoozeOpen(false),
    conversationScrollRef
  })

  useSelectedRowScroll(selectedRowRef, selectedIndex, readerOpen)

  const unreadCount = realUnreadTotal

  return (
    <div className="flex h-full flex-col">
      <MailHeader
        view={view}
        unreadCount={unreadCount}
        selectionCount={selectedIds.size}
        onSwitchView={switchView}
        queueReadout={<QueueReadout unread={unreadCount} pending={pendingCount} />}
        accountMenu={
          <div data-testid="account-menu">
            <AccountMenu status={status} onStatus={onStatus} />
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        <ThreadList
          threads={threads}
          view={view}
          syncing={sync.phase === 'syncing'}
          readerOpen={readerOpen}
          selectedIndex={selectedIndex}
          selectedIds={selectedIds}
          exitingThreadIds={exitingThreadIds}
          labelsById={userLabelsById}
          selectedRowRef={selectedRowRef}
          onExtendSelection={extendSelectionTo}
          onOpen={(index) => {
            setSelectedIndex(index)
            setReaderOpen(true)
          }}
        />

        {readerOpen && selected && (
          <ConversationView
            selected={selected}
            selectedIndex={selectedIndex}
            threadCount={threads.length}
            view={view}
            conversation={conversation}
            scrollRef={conversationScrollRef}
            onClose={closeReader}
            renderMessages={(current) => (
              <ConversationMessages
                key={current.threadId}
                conversation={current}
                account={activeAccount}
                onToast={showToast}
              />
            )}
          />
        )}
      </div>

      {snoozeOpen && selected && (
        <SnoozePicker
          targetCount={targetedThreads.length}
          onCancel={() => setSnoozeOpen(false)}
          onConfirm={snoozeSelected}
          onUnsnooze={view === 'snoozed' ? unsnoozeSelected : undefined}
        />
      )}

      {labelTarget && (
        <LabelPicker
          labels={labels}
          targets={[{ id: labelTarget.id, labelIds: labelTarget.labelIds }]}
          onClose={() => setLabelTargetId(null)}
          onToggle={toggleLabel}
        />
      )}

      <Toast toast={toast} />

      <footer className="relative z-40 flex min-h-11 items-center gap-4 border-t border-white/10 bg-raised px-6 py-1.5 text-xs text-ink-faint shadow-[0_-8px_24px_rgba(0,0,0,0.32)]">
        <div data-testid="footer-shortcuts" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {footerShortcuts(readerOpen).map((shortcut) => (
            <FooterShortcut key={shortcut.id} {...shortcut} />
          ))}
        </div>
        <SyncStatus
          sync={sync}
          networkOnline={networkOnline}
          onRetry={retrySync}
          onCopyError={copySyncError}
        />
      </footer>
    </div>
  )
}
