import type { Draft, DraftSaveInput } from '../../../shared/drafts'
import { MailIcon } from '../components/MailIcon'
import { formatBytes } from '../formatBytes'
import { modKeyLabel } from '../platform'
import { ComposerSaveStatus, type ComposerSaveStatusProps } from './ComposerChrome'
import { EditorToolbar } from './EditorToolbar'
import { FollowUpControl } from './FollowUpControl'

export function PaperclipIcon(): React.JSX.Element {
  return <MailIcon name="attachment" />
}

interface ComposerFooterProps extends ComposerSaveStatusProps {
  mode: 'full' | 'inline'
  visibleAttachments: Draft['attachments']
  attachmentError: string | null
  retryAttachment: () => void
  dismissAttachmentError: () => void
  attaching: boolean
  closing: boolean
  removeAttachment: (attachmentId: string) => void
  pickAttachments: () => void
  followUpAt: number | null
  followUpOpen: boolean
  setFollowUpOpen: React.Dispatch<React.SetStateAction<boolean>>
  setFollowUpAt: React.Dispatch<React.SetStateAction<number | null>>
  updateFields: (patch: Partial<Pick<DraftSaveInput, 'followUpAt'>>) => void
  discard: () => void
  send: () => void
}

export function ComposerFooter(props: ComposerFooterProps): React.JSX.Element {
  return (
    <footer
      data-testid="composer-footer"
      className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-t border-edge py-3"
    >
      <button
        type="button"
        data-testid="composer-send"
        disabled={props.attaching || props.closing}
        className="inline-flex cursor-pointer items-center gap-3 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-on-accent disabled:cursor-wait disabled:opacity-50"
        data-tooltip="Send message"
        onClick={props.send}
      >
        Send <span className="text-[10px]">{modKeyLabel()} ↵</span>
      </button>
      <EditorToolbar />
      <span aria-hidden className="mx-1 h-4 border-l border-edge" />
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-md text-ink-dim hover:bg-active hover:text-ink disabled:opacity-50"
        data-testid="composer-attach"
        aria-label="Attach files"
        data-tooltip={`Attach files (${modKeyLabel()}⇧A)`}
        disabled={props.attaching || props.closing}
        onClick={props.pickAttachments}
      >
        <PaperclipIcon />
      </button>
      <FollowUpControl
        followUpAt={props.followUpAt}
        open={props.followUpOpen}
        onOpenChange={props.setFollowUpOpen}
        onChange={(value) => {
          props.setFollowUpAt(value)
          props.updateFields({ followUpAt: value })
        }}
      />
      {props.visibleAttachments.length > 0 && (
        <span className="sr-only" data-testid="composer-attachment-count">
          {props.visibleAttachments.length} attachment{props.visibleAttachments.length === 1 ? '' : 's'}
        </span>
      )}
      <span className="ml-auto">{props.mode === 'full' && <ComposerSaveStatus {...props} />}</span>
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-md text-ink-dim hover:bg-active hover:text-danger disabled:opacity-50"
        data-testid="composer-discard"
        aria-label="Discard draft"
        data-tooltip={`Discard draft (${modKeyLabel()}⇧D)`}
        disabled={props.attaching || props.closing}
        onClick={props.discard}
      >
        <MailIcon name="trash" />
      </button>
    </footer>
  )
}

export function ComposerAttachments(
  props: Pick<
    ComposerFooterProps,
    | 'attachmentError'
    | 'retryAttachment'
    | 'dismissAttachmentError'
    | 'visibleAttachments'
    | 'attaching'
    | 'closing'
    | 'removeAttachment'
  >
): React.JSX.Element {
  return (
    <div data-testid="composer-attachments">
      {props.attachmentError && (
        <div
          data-testid="composer-attachment-error"
          role="alert"
          className="my-2 flex items-center gap-3 rounded-md bg-active px-3 py-2 text-xs"
        >
          <span className="flex-1 text-danger">{props.attachmentError}</span>
          <button
            type="button"
            className="app-button"
            onClick={props.retryAttachment}
            disabled={props.attaching || props.closing}
          >
            Retry
          </button>
          <button
            type="button"
            className="app-button"
            aria-label="Dismiss attachment error"
            onClick={props.dismissAttachmentError}
          >
            ×
          </button>
        </div>
      )}
      {props.visibleAttachments.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 py-2.5" data-testid="composer-attachment-chips">
          {props.visibleAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex min-w-0 max-w-72 items-center gap-2 rounded-md border border-edge bg-transparent px-2.5 py-1.5 text-xs"
              data-testid="composer-attachment-chip"
              data-attachment-id={attachment.id}
            >
              <PaperclipIcon />
              <span className="min-w-0 truncate font-normal text-ink-dim">{attachment.filename}</span>
              <span className="shrink-0 text-ink-faint">{formatBytes(attachment.sizeBytes)}</span>
              <button
                type="button"
                className="flex size-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-edge hover:text-ink"
                aria-label={`Remove ${attachment.filename}`}
                data-testid="composer-attachment-remove"
                disabled={props.attaching || props.closing}
                onClick={() => props.removeAttachment(attachment.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {props.attaching && (
        <div
          data-testid="composer-attachment-progress"
          role="status"
          className="flex items-center gap-2 py-2 text-xs text-ink-dim"
        >
          <span className="size-3 animate-pulse rounded-full bg-accent/40" /> Updating attachments…
        </div>
      )}
    </div>
  )
}
