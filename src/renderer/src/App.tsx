import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TriageAction } from '../../shared/actions'
import type { AuthStatus } from '../../shared/auth'
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
} from '../../shared/mail'
import { formatSnoozeDate, parseSnoozeText, snoozePresets } from '../../shared/snooze'
import {
  chordKey,
  createCommand,
  findCommandByShortcut,
  isChordPrefix,
  matchKey,
  readingScrollDelta,
  registerCommands
} from './commands'
import { dateGroup } from './dateGroup'
import { type LabelCheckState, LabelPicker } from './LabelPicker'
import { MessageBody } from './MessageBody'
import { getConversation as getMockConversation, mockThreads } from './mockData'
import { refreshedSelectionIndex } from './selection'

interface DisplayThread {
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
  labelIds: string[]
  lastMsgAt?: number
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

interface DisplayConversation {
  threadId: string
  subject: string
  messages: DisplayMsg[]
}

const CHIP_CLASS = 'app-no-drag rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint'
const LABEL_PALETTE = [
  { backgroundColor: '#44351b', borderColor: '#765b26', color: '#ffd789' },
  { backgroundColor: '#193b4a', borderColor: '#28647d', color: '#8cdbff' },
  { backgroundColor: '#263d2a', borderColor: '#3f6a48', color: '#a9e8b3' },
  { backgroundColor: '#402b43', borderColor: '#704a76', color: '#e6abe9' },
  { backgroundColor: '#452a2d', borderColor: '#75464b', color: '#ffadb3' },
  { backgroundColor: '#28334c', borderColor: '#465985', color: '#b8c9ff' }
] as const

function labelColor(labelId: string): (typeof LABEL_PALETTE)[number] {
  let hash = 0
  for (const character of labelId) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length]
}

function ThreadLabels({
  labelIds,
  labelsById
}: {
  labelIds: readonly string[]
  labelsById: ReadonlyMap<string, MailLabel>
}): React.JSX.Element {
  return (
    <>
      {labelIds.map((labelId) => {
        const label = labelsById.get(labelId)
        return label ? (
          <span
            key={labelId}
            data-testid="label-chip"
            title={label.name}
            className="max-w-24 flex-none truncate rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={labelColor(labelId)}
          >
            {label.name}
          </span>
        ) : null
      })}
    </>
  )
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
  return { ...fromThreadRow(r), dueAt: r.dueAt }
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

function displayFromMockId(threadId: string): DisplayConversation {
  const c = getMockConversation(threadId)
  return {
    threadId,
    subject: c.subject,
    messages: c.messages.map((m) => ({
      id: m.id,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      at: m.at,
      fullDate: m.at,
      recipients: {
        to: [{ name: m.to === 'you' ? 'me' : m.to, email: m.to }],
        cc: [],
        bcc: [],
        replyTo: []
      },
      attachments: [],
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

function ReminderChips({ thread }: { thread: DisplayThread }): React.JSX.Element {
  return (
    <>
      {thread.returned && (
        <span
          data-testid="chip-returned"
          className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-medium text-accent"
        >
          Returned
        </span>
      )}
      {thread.dueAt !== undefined && (
        <span
          data-testid="chip-snooze-due"
          title={formatSnoozeDate(thread.dueAt)}
          className="rounded-full border border-edge px-2 py-0.5 text-ink-dim"
        >
          {formatSnoozeDate(thread.dueAt)}
        </span>
      )}
    </>
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
          <b className="font-semibold text-accent">{unread}</b> to zero
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
  realMode,
  networkOnline,
  onRetry,
  onCopyError
}: {
  sync: SyncState
  realMode: boolean
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const displayState = !realMode
    ? 'disconnected'
    : sync.phase === 'error'
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
    if (!realMode || sync.phase !== 'error') setDetailsOpen(false)
  }, [realMode, sync.phase])

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
      : displayState === 'disconnected'
        ? 'Not connected'
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
      : displayState === 'disconnected'
        ? 'Demo inbox'
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

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [view, setView] = useState<'inbox' | 'snoozed'>('inbox')
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [selectionBaseIds, setSelectionBaseIds] = useState<ReadonlySet<string>>(new Set())
  const [readerOpen, setReaderOpen] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [mockReadIds, setMockReadIds] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const [exitingThreadIds, setExitingThreadIds] = useState<ReadonlySet<string>>(new Set())
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const conversationScrollRef = useRef<HTMLDivElement | null>(null)
  const convCache = useRef(new Map<string, DisplayConversation>())
  const selectedThreadIdRef = useRef<string | null>(null)
  const preserveSelectionOnRefreshRef = useRef(true)
  const activeViewRef = useRef<'inbox' | 'snoozed'>('inbox')
  const autoReadThreadRef = useRef<string | null>(null)
  const toastTokenRef = useRef(0)
  const pendingChordRef = useRef<{ key: string; until: number } | null>(null)
  const deferRefreshUntilRef = useRef(0)
  const earliestExitIndexRef = useRef<number | null>(null)

  const activeAccount = status?.signedIn ? (status.email ?? null) : null
  const realMode = Boolean(attn && status?.signedIn)
  const userLabelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])

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
    const onOffline = (): void => setNetworkOnline(false)
    const onOnline = (): void => {
      setNetworkOnline(true)
      void attn?.sync.retry().catch(() => {})
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    setRealThreads(null)
    setRealSnoozedThreads(null)
    setRealUnreadTotal(null)
    setLabels([])
    setSelectedIndex(0)
    setSelectedIds(new Set())
    setSelectionAnchorId(null)
    setSelectionBaseIds(new Set())
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
    setPendingCount(0)
    setMockReadIds(new Set())
    setConversation(null)
    setExitingThreadIds(new Set())
    selectedThreadIdRef.current = null
    preserveSelectionOnRefreshRef.current = true
    convCache.current.clear()

    if (!attn || !activeAccount) return
    let cancelled = false
    let deferredRefreshTimer: number | null = null
    const refresh = (): void => {
      const delay = deferRefreshUntilRef.current - Date.now()
      if (delay > 0) {
        if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
        deferredRefreshTimer = window.setTimeout(refresh, delay)
        return
      }
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      convCache.current.clear()
      void Promise.all([
        attn.mail.listThreads(),
        attn.mail.listSnoozed(),
        attn.mail.listLabels(),
        attn.mail.getUnreadCount(),
        attn.mail.getPendingActionCount()
      ])
        .then(([nextThreads, nextSnoozed, nextLabels, nextUnreadTotal, nextPendingCount]) => {
          if (cancelled) return
          const nextVisibleThreads = activeViewRef.current === 'inbox' ? nextThreads : nextSnoozed
          setSelectedIndex((current) =>
            refreshedSelectionIndex(
              nextVisibleThreads,
              preserveSelection ? selectedThreadIdRef.current : null,
              current
            )
          )
          setRealThreads(nextThreads)
          setRealSnoozedThreads(nextSnoozed)
          setLabels(nextLabels)
          setRealUnreadTotal(nextUnreadTotal)
          setPendingCount(nextPendingCount)
        })
        .catch(() => {})
    }
    refresh()
    const offMail = attn.mail.onChanged(refresh)
    return () => {
      cancelled = true
      if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
      offMail()
    }
  }, [activeAccount])

  const threads: DisplayThread[] = useMemo(() => {
    if (realMode) {
      return view === 'inbox'
        ? (realThreads ?? []).map(fromThreadRow)
        : (realSnoozedThreads ?? []).map(fromSnoozedThreadRow)
    }
    if (view === 'snoozed') return []
    return mockThreads.map((t) => ({
      id: t.id,
      from: t.from,
      subject: t.subject,
      snippet: t.snippet,
      at: t.at,
      unread: t.unread,
      starred: t.starred ?? false,
      hasAttachment: t.hasAttachment ?? false,
      returned: false,
      labelIds: []
    }))
  }, [realMode, realSnoozedThreads, realThreads, view])

  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(threads.length - 1, 0))))
    setExitingThreadIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      return next.size === current.size ? current : next
    })
    setSelectedIds((current) => {
      if (current.size === 0) return current
      const visibleIds = new Set(threads.map((thread) => thread.id))
      const next = new Set([...current].filter((id) => visibleIds.has(id)))
      if (next.size === current.size) return current
      return next
    })
    if (threads.length === 0) setReaderOpen(false)
  }, [threads])

  useEffect(() => {
    setSelectionAnchorId((anchor) => {
      if (anchor !== null && selectedIds.has(anchor) && threads.some((thread) => thread.id === anchor)) {
        return anchor
      }
      // Drop a stale anchor rather than retargeting it: extendSelectionTo falls back
      // to the cursor, which is where the user is actually looking.
      return null
    })
  }, [selectedIds, threads])

  const selected: DisplayThread | undefined = threads[selectedIndex]
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
    setConversation((current) => (current?.threadId === selected.id ? current : null))
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

  // Preload neighbors so opening and reader J/K navigation normally have no loading state (F3).
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
    setToast({ id: token, message })
    window.setTimeout(() => {
      if (toastTokenRef.current === token) setToast(null)
    }, 4000)
  }, [])

  const retrySync = useCallback(() => {
    void attn?.sync.retry().catch(() => {})
  }, [])

  const copySyncError = useCallback(
    (message: string) => {
      if (!navigator.clipboard) {
        showToast('Could not copy error details')
        return
      }
      void navigator.clipboard
        .writeText(message)
        .then(() => showToast('Error details copied'))
        .catch(() => showToast('Could not copy error details'))
    },
    [showToast]
  )

  useLayoutEffect(() => {
    if (!realMode || sync.phase !== 'error') return
    return registerCommands([
      createCommand('sync.retry', retrySync),
      createCommand('sync.error.copy', () => copySyncError(sync.message))
    ])
  }, [copySyncError, realMode, retrySync, sync])

  const switchView = useCallback((next: 'inbox' | 'snoozed') => {
    activeViewRef.current = next
    selectedThreadIdRef.current = null
    setView(next)
    setSelectedIndex(0)
    setReaderOpen(false)
    setSnoozeOpen(false)
    setLabelTargetId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setSelectionAnchorId(null)
    setSelectionBaseIds(new Set())
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
  }, [activeAccount, clearSelection, switchView])

  const toggleFocusedSelection = useCallback(() => {
    const thread = threads[selectedIndex]
    if (!thread) return
    const next = new Set(selectedIds)
    const isAdding = !next.has(thread.id)
    if (isAdding) next.add(thread.id)
    else next.delete(thread.id)
    setSelectedIds(next)
    setSelectionBaseIds(next)
    if (isAdding) setSelectionAnchorId(thread.id)
    else if (next.size === 0 || selectionAnchorId === thread.id) setSelectionAnchorId(null)
  }, [selectedIds, selectedIndex, selectionAnchorId, threads])

  const extendSelectionTo = useCallback(
    (nextIndex: number) => {
      if (threads.length === 0) return
      const clampedIndex = Math.max(0, Math.min(nextIndex, threads.length - 1))
      const storedAnchorIndex = selectionAnchorId
        ? threads.findIndex((thread) => thread.id === selectionAnchorId)
        : -1
      const hasAnchor = storedAnchorIndex >= 0
      const anchorIndex = hasAnchor ? storedAnchorIndex : selectedIndex
      const start = Math.min(anchorIndex, clampedIndex)
      const end = Math.max(anchorIndex, clampedIndex)
      // Rebuild from the selection captured when the anchor was set, so walking the
      // range back with Shift+K shrinks it instead of accumulating every row crossed.
      const base = hasAnchor ? selectionBaseIds : selectedIds
      const next = new Set(base)
      for (const thread of threads.slice(start, end + 1)) next.add(thread.id)
      setSelectedIds(next)
      if (!hasAnchor) setSelectionBaseIds(selectedIds)
      setSelectionAnchorId(threads[anchorIndex]?.id ?? null)
      setSelectedIndex(clampedIndex)
    },
    [selectedIds, selectedIndex, selectionAnchorId, selectionBaseIds, threads]
  )

  const triage = useCallback(
    (action: TriageAction) => {
      if (!realMode || !attn) return
      preserveSelectionOnRefreshRef.current = false
      const isBulk = selectedIds.size > 0
      const targetedAction = {
        ...action,
        threadIds: isBulk ? [...selectedIds] : action.threadIds
      }
      if (isBulk) clearSelection()
      if (action.kind === 'archive' && view === 'inbox' && !readerOpen) {
        setExitingThreadIds((current) => new Set([...current, ...targetedAction.threadIds]))
        const exitDuration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550
        deferRefreshUntilRef.current = Math.max(deferRefreshUntilRef.current, Date.now() + exitDuration)
        earliestExitIndexRef.current = Math.min(earliestExitIndexRef.current ?? selectedIndex, selectedIndex)
        setSelectedIndex((index) => Math.min(index + targetedAction.threadIds.length, threads.length - 1))
        window.setTimeout(() => {
          const earliest = earliestExitIndexRef.current
          earliestExitIndexRef.current = null
          if (earliest !== null) setSelectedIndex(earliest)
        }, exitDuration)
      }
      void attn.mail
        .triage(targetedAction)
        .then((result) => showToast(result.label))
        .catch(() => {
          preserveSelectionOnRefreshRef.current = true
          setExitingThreadIds((current) => {
            const next = new Set(current)
            for (const id of targetedAction.threadIds) next.delete(id)
            return next
          })
        })
    },
    [clearSelection, readerOpen, realMode, selectedIds, selectedIndex, showToast, threads.length, view]
  )

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
      if (!realMode || !attn || !selected) return
      const isBulk = selectedIds.size > 0
      const threadIds = isBulk ? [...selectedIds] : [selected.id]
      setSnoozeOpen(false)
      if (isBulk) clearSelection()
      void attn.mail
        .snooze(threadIds, dueAt)
        .then((result) => showToast(result.label))
        .catch(() => {})
    },
    [clearSelection, realMode, selected, selectedIds, showToast]
  )

  const unsnoozeSelected = useCallback(() => {
    if (!selected) return
    setSnoozeOpen(false)
    triage({ kind: 'unsnooze', threadIds: [selected.id] })
  }, [selected, triage])

  useEffect(() => {
    if (!readerOpen) {
      autoReadThreadRef.current = null
      return
    }
    if (!selected || autoReadThreadRef.current === selected.id) return
    autoReadThreadRef.current = selected.id
    if (realMode) {
      void attn?.mail.markReadOnOpen(selected.id).catch(() => {})
    } else if (selected.unread) {
      setMockReadIds((current) => (current.has(selected.id) ? current : new Set(current).add(selected.id)))
    }
  }, [readerOpen, realMode, selected])

  // Reset the reused reading container before paint, then refocus after reader J/K navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected id deliberately resets scroll and focus
  useLayoutEffect(() => {
    if (!readerOpen) return
    const scroll = conversationScrollRef.current
    if (!scroll) return
    scroll.scrollTop = 0
    scroll.scrollLeft = 0
    scroll.focus({ preventScroll: true })
  }, [readerOpen, selected?.id])

  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('navigate.next', () =>
          setSelectedIndex((i) => Math.min(i + 1, Math.max(threads.length - 1, 0)))
        ),
        createCommand('navigate.previous', () => setSelectedIndex((i) => Math.max(i - 1, 0))),
        createCommand('selection.toggle', toggleFocusedSelection),
        createCommand('selection.extendNext', () => extendSelectionTo(selectedIndex + 1)),
        createCommand('selection.extendPrevious', () => extendSelectionTo(selectedIndex - 1)),
        ...(selectedIds.size > 0 ? [createCommand('selection.clear', clearSelection)] : []),
        ...(readerOpen
          ? [createCommand('conversation.close', closeReader)]
          : [createCommand('conversation.open', openSelected)]),
        createCommand('view.inbox', () => switchView('inbox')),
        createCommand('view.snoozed', () => switchView('snoozed')),
        createCommand('triage.archive', () => {
          if (selected) triage({ kind: 'archive', threadIds: [selected.id] })
        }),
        createCommand('triage.snooze', () => selected && setSnoozeOpen(true), {
          title: view === 'snoozed' ? 'Change reminder / unsnooze' : 'Snooze / remind me later'
        }),
        createCommand('triage.trash', () => {
          if (selected) triage({ kind: 'trash', threadIds: [selected.id] })
        }),
        createCommand('triage.spam', () => {
          if (selected) triage({ kind: 'spam', threadIds: [selected.id] })
        }),
        createCommand(
          'triage.star',
          () => selected && triage({ kind: 'star', threadIds: [selected.id], on: starOn }),
          { title: starOn ? 'Star' : 'Unstar' }
        ),
        createCommand(
          'triage.unread',
          () => selected && triage({ kind: 'markUnread', threadIds: [selected.id], on: markUnreadOn }),
          { title: markUnreadOn ? 'Mark unread' : 'Mark read' }
        ),
        createCommand('triage.label', () => {
          if (selected && realMode) setLabelTargetId(selected.id)
        }),
        createCommand('triage.undo', () => {
          if (!realMode || !attn) return
          preserveSelectionOnRefreshRef.current = false
          void attn.mail
            .undo()
            .then((result) => {
              if (result) showToast(result.label)
              else preserveSelectionOnRefreshRef.current = true
            })
            .catch(() => {
              preserveSelectionOnRefreshRef.current = true
            })
        })
      ]),
    [
      clearSelection,
      closeReader,
      extendSelectionTo,
      openSelected,
      readerOpen,
      realMode,
      markUnreadOn,
      selected,
      selectedIds.size,
      selectedIndex,
      showToast,
      starOn,
      switchView,
      threads.length,
      toggleFocusedSelection,
      triage,
      view
    ]
  )

  useLayoutEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const key = chordKey(e)
      const pendingChord = pendingChordRef.current
      pendingChordRef.current = null
      if (labelTarget) return
      if (snoozeOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setSnoozeOpen(false)
        }
        return
      }
      const target = e.target as HTMLElement | null
      const isTextEntry =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (isTextEntry) return
      // Focused controls keep their native activation keys, but Escape remains
      // the app-level Back action from every Tab stop in the reader.
      if (target && target.tagName === 'BUTTON' && e.key !== 'Escape') return
      const context = readerOpen ? 'reader' : 'list'
      const scroll = conversationScrollRef.current
      if (readerOpen && scroll) {
        const scrollDelta = readingScrollDelta(e, scroll.clientHeight)
        if (scrollDelta !== null) {
          e.preventDefault()
          scroll.scrollBy({ top: scrollDelta })
          return
        }
      }
      if (key !== null && pendingChord && Date.now() <= pendingChord.until) {
        const command = findCommandByShortcut(`${pendingChord.key} ${key}`, context)
        if (!command) return
        e.preventDefault()
        command.run()
        return
      }
      if (key !== null && isChordPrefix(key, context)) {
        e.preventDefault()
        pendingChordRef.current = { key, until: Date.now() + 500 }
        return
      }
      const command = matchKey(e, context)
      if (!command) return
      e.preventDefault()
      command.run()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [labelTarget, readerOpen, snoozeOpen])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex and readerOpen are deliberate triggers — scroll after every selection change, ref itself never changes
  useLayoutEffect(() => {
    // While the reader is open the list is display:none, so scrollIntoView is a
    // no-op and J/K moves leave it at a stale offset. Re-running as the reader
    // closes brings the cursor back into view; `nearest` scrolls the minimum, so
    // a conversation opened and closed without navigating keeps its position.
    selectedRowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex, readerOpen])

  const visibleUnreadTotal = threads.filter((t) => t.unread).length
  const mockReadTotal = threads.filter((t) => t.unread && mockReadIds.has(t.id)).length
  const unreadCount =
    realMode && realUnreadTotal === null
      ? null
      : realMode
        ? (realUnreadTotal ?? 0)
        : visibleUnreadTotal - mockReadTotal

  const footerShortcuts: ShortcutHint[] = [
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

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex items-center gap-6 border-b border-edge px-6 py-3">
        <div className="text-base font-bold tracking-tight">
          attn<span className="text-accent">:</span>
        </div>
        <div data-testid="view-title" className="text-sm font-semibold text-ink-dim">
          {view === 'inbox' ? 'Inbox' : 'Snoozed'}
        </div>
        <nav className="app-no-drag flex gap-1">
          <button
            type="button"
            onClick={() => switchView('inbox')}
            className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
              view === 'inbox' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            Important
            {unreadCount !== null && unreadCount > 0 && (
              <span className="ml-1.5 text-xs font-semibold text-accent tabular-nums">{unreadCount}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => switchView('snoozed')}
            className={`cursor-pointer rounded-[7px] px-3 py-1.5 text-[13px] font-medium ${
              view === 'snoozed' ? 'bg-active text-ink' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            Snoozed
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
          {selectedIds.size > 0 && (
            <span
              data-testid="selection-count"
              className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent tabular-nums"
            >
              {selectedIds.size} selected
            </span>
          )}
          <QueueReadout unread={unreadCount} pending={pendingCount} />
          <div data-testid="account-menu">
            <AccountMenu status={status} onStatus={setStatus} />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main
          data-testid="thread-list"
          // `hidden` is display:none, which already removes the list from the
          // accessibility tree and tab order while reading — no aria-hidden needed.
          className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2 ${readerOpen ? 'hidden' : ''}`}
          aria-label="Conversation list"
        >
          {threads.length === 0 && (
            <div className="flex h-full items-center justify-center text-ink-faint">
              {sync.phase === 'syncing'
                ? 'Syncing your inbox…'
                : view === 'snoozed'
                  ? 'Nothing snoozed'
                  : 'Inbox empty'}
            </div>
          )}
          {threads.map((t, i) => {
            const isSelected = i === selectedIndex
            const isChecked = selectedIds.has(t.id)
            const isUnread = t.unread && !mockReadIds.has(t.id)
            const group = dateGroup(t)
            const showGroup = view === 'inbox' && (i === 0 || dateGroup(threads[i - 1]) !== group)
            const isExiting = exitingThreadIds.has(t.id)
            return (
              <div key={t.id} className="overflow-x-clip">
                {showGroup && (
                  <div
                    data-testid="thread-date-group"
                    className="select-none px-8 pt-5 pb-2 text-xs font-semibold text-ink-faint"
                  >
                    {group}
                  </div>
                )}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard access is global (J/K/Enter, F3) — clicks are a supplementary pointer target */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: same — row selection is driven by the app-level key handler, not per-row focus */}
                <div
                  ref={isSelected ? selectedRowRef : null}
                  data-testid="thread-row"
                  data-selected={isSelected || undefined}
                  data-checked={isChecked || undefined}
                  data-unread={isUnread || undefined}
                  data-exiting={isExiting || undefined}
                  className={`flex cursor-default select-none items-center gap-3.5 border-l-[3px] py-[11px] pr-7 pl-5 ${isSelected ? 'border-l-accent' : 'border-l-transparent'} ${
                    isChecked ? 'bg-accent/[0.12]' : isSelected ? 'bg-accent/[0.07]' : ''
                  } ${isExiting ? 'app-thread-exit' : ''}`}
                  onClick={(event) => {
                    if (event.shiftKey) extendSelectionTo(i)
                    else {
                      setSelectedIndex(i)
                      setReaderOpen(true)
                    }
                  }}
                >
                  <span className="flex size-4 flex-none items-center justify-center self-center" aria-hidden>
                    {isChecked ? (
                      <span className="flex size-4 items-center justify-center rounded-[4px] bg-accent text-[11px] font-bold text-ground">
                        ✓
                      </span>
                    ) : (
                      <span
                        className={`size-1.5 rounded-full ${
                          isUnread ? 'bg-accent shadow-[0_0_6px_rgba(255,178,36,0.45)]' : 'bg-transparent'
                        }`}
                      />
                    )}
                  </span>
                  <span
                    data-testid="thread-sender"
                    className={`w-52 flex-none overflow-hidden text-ellipsis whitespace-nowrap ${
                      isUnread ? 'font-semibold text-ink' : 'text-ink-dim'
                    }`}
                  >
                    {t.from}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-faint">
                    <ThreadLabels labelIds={t.labelIds} labelsById={userLabelsById} />
                    {t.starred && (
                      <span className="flex-none text-star" title="Starred">
                        ★
                      </span>
                    )}
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      <span
                        data-testid="thread-subject"
                        className={isUnread ? 'font-semibold text-ink' : 'text-ink-dim'}
                      >
                        {t.subject}
                      </span>
                      <span data-testid="thread-snippet"> — {t.snippet}</span>
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-2.5 text-xs">
                    <ReminderChips thread={t} />
                    {t.hasAttachment && <span title="Has attachment">📎</span>}
                    <span
                      className={`min-w-[70px] text-right tabular-nums ${
                        isUnread ? 'font-medium text-accent' : 'text-ink-faint'
                      }`}
                    >
                      {t.at}
                    </span>
                  </span>
                </div>
              </div>
            )
          })}
        </main>

        {readerOpen && selected && (
          <section data-testid="conversation-view" className="flex min-w-0 flex-1 flex-col bg-raised/35">
            <div className="flex items-center gap-4 border-b border-edge px-6 pt-3 pb-3">
              <button
                type="button"
                data-testid="conversation-back"
                className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
                onClick={closeReader}
              >
                <span aria-hidden>←</span> {view === 'inbox' ? 'Inbox' : 'Snoozed'}
              </button>
              <h1
                data-testid="conversation-subject"
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-lg font-bold tracking-tight"
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
            <div
              ref={conversationScrollRef}
              data-testid="conversation-scroll"
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto px-6 py-5 focus:outline-none [scrollbar-gutter:stable]"
            >
              {conversation ? (
                <div
                  data-testid="conversation-content"
                  className="mx-auto flex w-full flex-col gap-3.5"
                  style={{ maxWidth: 'clamp(720px, 72vw, 1120px)' }}
                >
                  <ConversationMessages
                    key={conversation.threadId}
                    conversation={conversation}
                    account={activeAccount}
                    onToast={showToast}
                  />
                </div>
              ) : (
                <div className="py-10 text-center text-ink-faint">Loading…</div>
              )}
            </div>
          </section>
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

      {toast && (
        <div
          key={toast.id}
          data-testid="toast"
          data-toast-id={toast.id}
          className="pointer-events-none fixed bottom-14 left-1/2 z-50 -translate-x-1/2"
        >
          <div className="app-confirmation-toast rounded-xl border border-white/70 bg-ink px-5 py-3 text-base font-semibold text-ground shadow-[0_12px_40px_rgba(0,0,0,0.65)]">
            {toast.message}
          </div>
        </div>
      )}

      <footer className="relative z-40 flex min-h-11 items-center gap-4 border-t border-white/10 bg-raised px-6 py-1.5 text-xs text-ink-faint shadow-[0_-8px_24px_rgba(0,0,0,0.32)]">
        <div data-testid="footer-shortcuts" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {footerShortcuts.map((shortcut) => (
            <FooterShortcut key={shortcut.id} {...shortcut} />
          ))}
        </div>
        <SyncStatus
          sync={sync}
          realMode={realMode}
          networkOnline={networkOnline}
          onRetry={retrySync}
          onCopyError={copySyncError}
        />
      </footer>
    </div>
  )
}
