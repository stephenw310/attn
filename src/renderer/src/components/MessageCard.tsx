import { useCallback, useMemo, useState } from 'react'
import { normalizeEmailKey } from '../../../shared/address'
import type { MailAddress, MessageAttachment, MessageRecipients } from '../../../shared/mail'
import { formatBytes } from '../formatBytes'
import type { DisplayMessage } from '../list/mailDisplay'
import { MessageBody } from '../MessageBody'
import { mailReadingForHtml } from '../mailReading'
import { useTheme } from '../theme'
import { useShowToast } from '../toastContext'
import { TornRule } from './Hand'

function firstName(address: MailAddress, account: string | null): string {
  if (account && normalizeEmailKey(address.email) === normalizeEmailKey(account)) return 'me'
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
  message: DisplayMessage
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
          className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border border-edge bg-active/60 p-3 text-xs text-ink-faint"
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

interface MessageCardProps {
  threadId: string
  message: DisplayMessage
  account: string | null
  collapsed?: boolean
  active?: boolean
  onToggleCollapsed?: () => void
  trimExpanded?: boolean
  onToggleTrim: () => void
  bodyHydrationMessage?: string
}

export function MessageCard(props: MessageCardProps): React.JSX.Element {
  const {
    threadId,
    message,
    account,
    collapsed = false,
    active = false,
    onToggleCollapsed,
    trimExpanded = false,
    onToggleTrim,
    bodyHydrationMessage
  } = props
  const onToast = useShowToast()
  const { appearance } = useTheme()
  const [viewOriginal, setViewOriginal] = useState(false)
  const reading = useMemo(() => mailReadingForHtml(message.html), [message.html])
  const detectedPresentation = reading.presentation
  const presentation =
    viewOriginal && detectedPresentation.surface === 'native'
      ? { ...detectedPresentation, surface: 'light' as const }
      : detectedPresentation
  const htmlSurface = presentation.surface === 'light'
  const visibleAttachments = message.attachments.filter((attachment) => !attachment.inline)

  const download = useCallback(
    (attachment: MessageAttachment) => {
      if (message.pending) {
        onToast('Attachment available after sending completes')
        return
      }
      if (!window.attn) {
        onToast('Attachments download when signed in')
        return
      }
      void window.attn.mail
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
    [message.id, message.pending, onToast]
  )

  if (collapsed) {
    return (
      <article
        data-testid="message-card"
        data-collapsed="true"
        data-pending={message.pending ? 'true' : undefined}
      >
        <TornRule className="w-full" />
        <button
          type="button"
          data-testid="older-message-toggle"
          aria-expanded="false"
          aria-label={`Expand older message from ${message.fromName}`}
          onClick={(event) => {
            onToggleCollapsed?.()
            event.currentTarget.blur()
          }}
          className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-1 py-2.5 text-left text-ink-faint hover:text-ink-dim"
        >
          <span className="min-w-0 font-bold text-ink-dim">{message.fromName}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[14px] text-ink-faint">
            {message.text || 'HTML message'}
          </span>
          <span className="app-figures flex items-baseline gap-2 text-[14px] text-ink-faint">
            {visibleAttachments.length > 0 && <span title="Has attachment">📎</span>}
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
      data-pending={message.pending ? 'true' : undefined}
      className={`relative px-1 pt-5 pb-4 ${active ? 'app-message-active' : ''}`}
    >
      <TornRule className="mb-4 w-full" />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: message keyboard control is app-level */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: nested controls remain independently interactive */}
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
            <span className="text-[17px] font-bold text-ink">{message.fromName}</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-ink-faint">
              &lt;{message.fromEmail}&gt;
            </span>
          </div>
        </div>
        <span className="app-figures flex flex-none items-center gap-2 text-[14px] text-ink-faint">
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
              className="cursor-pointer px-1 text-ink-faint hover:text-ink-dim"
            >
              <span aria-hidden>▴</span>
            </button>
          )}
        </span>
        <div className="col-span-2 min-w-0">
          <RecipientLine message={message} account={account} />
        </div>
        {message.html && detectedPresentation.surface === 'native' && appearance === 'dark' && (
          <button
            type="button"
            data-testid="mail-original-toggle"
            onClick={(event) => {
              setViewOriginal((current) => !current)
              event.currentTarget.blur()
            }}
            className="app-small-caps col-span-2 mt-1 w-fit cursor-pointer text-[13px] text-accent hover:underline"
          >
            {viewOriginal ? 'Use dark view' : 'View original'}
          </button>
        )}
      </div>
      <div
        data-testid="message-content"
        className={`min-w-0 ${htmlSurface ? 'app-enclosure overflow-hidden bg-mail-light-ground' : ''}`}
      >
        <MessageBody
          bodyText={message.text}
          bodyHtml={message.html}
          surface={presentation.surface}
          layout={presentation.layout}
          appearance={appearance}
          viewOriginal={viewOriginal}
          parts={reading.parts}
          threadId={threadId}
          messageId={message.id}
          attachments={message.attachments}
          expanded={trimExpanded}
          onToggleTrim={onToggleTrim}
        />
        <p
          data-testid="body-hydration-status"
          className={bodyHydrationMessage ? 'mt-3 text-xs text-ink-faint' : 'sr-only'}
          aria-live="polite"
          aria-atomic="true"
        >
          {bodyHydrationMessage ?? ''}
        </p>
        {visibleAttachments.length > 0 && (
          <div
            data-testid="message-accessories"
            className={htmlSurface ? 'bg-mail-light-ground px-3 pb-3' : ''}
          >
            <div className="mt-3 flex flex-wrap gap-2">
              {visibleAttachments.map((attachment) => (
                <button
                  key={attachment.attachmentId}
                  type="button"
                  data-testid="attachment-chip"
                  onClick={(event) => {
                    download(attachment)
                    event.currentTarget.blur()
                  }}
                  className={`cursor-pointer border px-3 py-2 text-left text-xs ${
                    htmlSurface
                      ? 'border-mail-light-edge bg-mail-light-raised text-mail-light-ink-dim hover:border-mail-light-edge-hover hover:text-mail-light-ink'
                      : 'border-edge bg-active text-ink-dim hover:border-accent hover:text-ink'
                  }`}
                  title={`Download ${attachment.filename}`}
                >
                  <span className="mr-2" aria-hidden>
                    📎
                  </span>
                  <span className="font-medium">{attachment.filename}</span>
                  <span
                    className={`ml-2 tabular-nums ${htmlSurface ? 'text-mail-light-ink-dim' : 'text-ink-faint'}`}
                  >
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
