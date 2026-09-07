import type { MailAddress } from '../../../shared/address'
import type { Draft, DraftSaveInput } from '../../../shared/drafts'
import { Kbd } from '../components/Kbd'
import { modKeyLabel } from '../platform'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import type { ComposerDraftController } from './useComposerDraft'

interface ComposerHeaderProps {
  draft: Draft
  mode: 'full' | 'inline'
  attaching: boolean
  closing: boolean
  localRevision: number
  savedRevision: number
  saveStatus: ComposerDraftController['saveStatus']
  closeAndSave: () => void
}

interface ComposerEnvelopeProps {
  draft: Draft
  mode: 'full' | 'inline'
  attaching: boolean
  to: MailAddress[]
  setTo: React.Dispatch<React.SetStateAction<MailAddress[]>>
  cc: MailAddress[]
  setCc: React.Dispatch<React.SetStateAction<MailAddress[]>>
  bcc: MailAddress[]
  setBcc: React.Dispatch<React.SetStateAction<MailAddress[]>>
  toFieldRef: React.RefObject<RecipientFieldHandle | null>
  ccFieldRef: React.RefObject<RecipientFieldHandle | null>
  bccFieldRef: React.RefObject<RecipientFieldHandle | null>
  showCopies: boolean
  setShowCopies: React.Dispatch<React.SetStateAction<boolean>>
  subject: string
  setSubject: React.Dispatch<React.SetStateAction<string>>
  updateFields: (patch: Partial<Pick<DraftSaveInput, 'to' | 'cc' | 'bcc' | 'subject'>>) => void
  notePendingRecipientChange: () => void
  sendError: string | null
  hasPreservedContent: boolean
}

export function composerTitle(kind: Draft['kind']): string {
  if (kind === 'reply') return 'Reply'
  if (kind === 'replyAll') return 'Reply all'
  if (kind === 'forward') return 'Forward'
  return 'New message'
}

export function ComposerHeader(props: ComposerHeaderProps): React.JSX.Element {
  const { draft, mode } = props
  return (
    <header
      className={`flex shrink-0 items-center border-b border-edge ${
        mode === 'inline' ? 'min-h-12 gap-3 px-4 py-2' : 'min-h-13 gap-4 px-6 py-2.5'
      }`}
      data-testid={mode === 'inline' ? 'composer-inline-header' : undefined}
    >
      {mode === 'full' ? (
        <button
          type="button"
          className="app-no-drag flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink disabled:cursor-wait disabled:opacity-50"
          data-testid="composer-close"
          aria-label="Save draft and go back"
          disabled={props.attaching || props.closing}
          onClick={props.closeAndSave}
        >
          <span aria-hidden>←</span> Back
        </button>
      ) : (
        <span className="flex size-7 flex-none items-center justify-center rounded-full bg-accent/10 text-sm text-accent">
          {draft.kind === 'forward' ? '↪' : '↩'}
        </span>
      )}
      <div className="flex min-w-0 items-center gap-2">
        {mode === 'full' && <span className="h-2 w-2 rounded-full bg-accent" />}
        <h1 className={`${mode === 'inline' ? 'text-sm' : 'text-base'} font-bold tracking-tight text-ink`}>
          {composerTitle(draft.kind)}
        </h1>
        <span
          className="text-[11px] text-ink-faint"
          data-testid="composer-save-status"
          data-local-revision={props.localRevision}
          data-saved-revision={props.savedRevision}
          data-save-status={props.saveStatus}
        >
          {props.saveStatus === 'saving'
            ? 'Saving…'
            : props.saveStatus === 'unsaved'
              ? 'Unsaved changes'
              : props.saveStatus === 'error'
                ? 'Save failed — retrying'
                : 'Saved locally'}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {mode === 'full' ? (
          <span className="flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="flex items-center gap-1.5" data-testid="composer-undo-hint">
              undo <Kbd>{modKeyLabel()}Z</Kbd>
            </span>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1.5">
              save &amp; close <Kbd>Esc</Kbd>
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="flex size-7 items-center justify-center text-lg text-ink-faint hover:bg-active hover:text-ink"
            data-testid="composer-close"
            aria-label="Save and close draft"
            title="Save and close draft (Esc)"
            onClick={props.closeAndSave}
          >
            ×
          </button>
        )}
      </div>
    </header>
  )
}

export function ComposerEnvelope(props: ComposerEnvelopeProps): React.JSX.Element {
  const { draft, mode } = props
  return (
    <>
      <div
        className="flex min-h-11 shrink-0 items-baseline gap-4 border-b border-edge px-6 pt-2 pb-1.5"
        data-testid="composer-from"
        data-email={draft.accountId}
      >
        <span className="app-small-caps w-14 shrink-0 text-[13.5px] text-accent">From</span>
        <span className="min-w-0 truncate text-[16px] text-ink">{draft.accountId}</span>
      </div>
      <div className="relative">
        <RecipientField
          ref={props.toFieldRef}
          field="to"
          label="To"
          recipients={props.to}
          autoFocus={mode === 'full' || draft.kind === 'forward'}
          onPendingChange={props.notePendingRecipientChange}
          onChange={(recipients) => {
            props.setTo(recipients)
            props.updateFields({ to: recipients })
          }}
        />
        {!props.showCopies && (
          <button
            type="button"
            className="app-small-caps absolute top-2 right-5 inline-flex h-7 items-center gap-1 px-1 text-[13px] text-ink-faint hover:text-ink"
            data-testid="composer-show-copies"
            aria-label="Show Cc and Bcc fields"
            aria-expanded="false"
            onClick={() => props.setShowCopies(true)}
          >
            Cc Bcc
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <title>Show Cc and Bcc fields</title>
              <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {props.showCopies && (
        <>
          <RecipientField
            ref={props.ccFieldRef}
            field="cc"
            label="Cc"
            recipients={props.cc}
            onPendingChange={props.notePendingRecipientChange}
            onChange={(recipients) => {
              props.setCc(recipients)
              props.updateFields({ cc: recipients })
            }}
          />
          <RecipientField
            ref={props.bccFieldRef}
            field="bcc"
            label="Bcc"
            recipients={props.bcc}
            onPendingChange={props.notePendingRecipientChange}
            onChange={(recipients) => {
              props.setBcc(recipients)
              props.updateFields({ bcc: recipients })
            }}
          />
        </>
      )}
      {mode === 'full' && (
        <input
          className="font-serif h-14 shrink-0 border-b border-edge bg-transparent px-6 text-[26px] text-ink outline-none placeholder:text-ink-faint"
          data-testid="composer-subject"
          aria-label="Subject"
          placeholder="Subject"
          value={props.subject}
          onChange={(event) => {
            props.setSubject(event.target.value)
            props.updateFields({ subject: event.target.value })
          }}
        />
      )}
      {props.sendError && (
        <div
          data-testid="composer-send-error"
          className="border-b border-danger/35 bg-danger/10 px-4 py-2 text-xs text-danger"
        >
          {props.sendError}
        </div>
      )}
      {props.attaching && (
        <div className="h-0.5 shrink-0 overflow-hidden bg-edge" data-testid="composer-attach-progress">
          <div className="app-attachment-progress h-full w-1/3 bg-accent" />
        </div>
      )}
      {props.hasPreservedContent && (
        <div
          data-testid="composer-preserved-banner"
          className="border-b border-edge bg-accent/[0.06] px-4 py-2 text-xs text-ink-dim"
        >
          Some formatting is preserved as read-only content and will be sent unchanged.
        </div>
      )}
    </>
  )
}
