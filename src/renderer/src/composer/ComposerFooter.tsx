import type { Draft, DraftSaveInput } from '../../../shared/drafts'
import { formatBytes } from '../formatBytes'
import { modKeyLabel } from '../platform'
import { EditorToolbar } from './EditorToolbar'
import { FollowUpControl } from './FollowUpControl'

function TrashIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <title>{`Discard draft (${modKeyLabel()}⇧D)`}</title>
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" strokeLinecap="round" />
    </svg>
  )
}

export function PaperclipIcon({ title = 'Attachment' }: { title?: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <title>{title}</title>
      <path
        d="m8.5 12.5 6.2-6.2a3 3 0 0 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface ComposerFooterProps {
  visibleAttachments: Draft['attachments']
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
    <>
      {props.visibleAttachments.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap gap-2 border-t border-edge px-4 py-2.5"
          data-testid="composer-attachment-chips"
        >
          {props.visibleAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex min-w-0 max-w-72 items-center gap-2 rounded-lg border border-edge bg-active/60 px-2.5 py-1.5 text-xs"
              data-testid="composer-attachment-chip"
              data-attachment-id={attachment.id}
            >
              <PaperclipIcon />
              <span className="min-w-0 truncate font-medium text-ink">{attachment.filename}</span>
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
      <footer
        data-testid="composer-footer"
        className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-edge px-4"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
          <EditorToolbar />
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink disabled:cursor-wait disabled:opacity-50"
            data-testid="composer-attach"
            aria-label="Attach files"
            title={`Attach files (${modKeyLabel()}⇧A)`}
            disabled={props.attaching || props.closing}
            onClick={props.pickAttachments}
          >
            <PaperclipIcon title={`Attach files (${modKeyLabel()}⇧A)`} />
          </button>
          {props.visibleAttachments.length > 0 && (
            <div
              className="shrink-0 border-l border-edge pl-3 text-xs text-ink-faint"
              data-testid="composer-attachments"
            >
              {props.visibleAttachments.length} attachment{props.visibleAttachments.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <FollowUpControl
            followUpAt={props.followUpAt}
            open={props.followUpOpen}
            onOpenChange={props.setFollowUpOpen}
            onChange={(value) => {
              props.setFollowUpAt(value)
              props.updateFields({ followUpAt: value })
            }}
          />
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-danger disabled:cursor-wait disabled:opacity-50"
            data-testid="composer-discard"
            aria-label="Discard draft"
            title={`Discard draft (${modKeyLabel()}⇧D)`}
            disabled={props.attaching || props.closing}
            onClick={props.discard}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            data-testid="composer-send"
            disabled={props.attaching || props.closing}
            className="cursor-pointer rounded-md bg-accent/20 px-3.5 py-2 text-xs font-semibold text-accent disabled:cursor-wait disabled:opacity-50"
            title="Send message"
            onClick={props.send}
          >
            Send <span className="ml-1 opacity-65">{modKeyLabel()}↵</span>
          </button>
        </div>
      </footer>
    </>
  )
}
