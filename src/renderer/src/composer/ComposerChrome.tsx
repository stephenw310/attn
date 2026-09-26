import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MailAddress } from '../../../shared/address'
import type { Draft, DraftSaveInput, SendAsIdentity } from '../../../shared/drafts'
import { createCommand, registerCommands } from '../commands'
import { Button } from '../components/Button'
import { Kbd } from '../components/Kbd'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import { SenderMenu } from './SenderMenu'
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
  closing: boolean
  closeAndSave: () => void
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
  updateFields: (
    patch: Partial<Pick<DraftSaveInput, 'senderEmail' | 'to' | 'cc' | 'bcc' | 'subject'>>
  ) => void
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

export type ComposerSaveStatusProps = Pick<
  ComposerHeaderProps,
  'saveStatus' | 'localRevision' | 'savedRevision'
>

export function ComposerSaveStatus(props: ComposerSaveStatusProps): React.JSX.Element {
  return (
    <span
      className={`text-[11px] ${props.saveStatus === 'error' ? 'text-danger' : 'text-ink-dim'}`}
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
  )
}

export function ComposerHeader(props: ComposerHeaderProps): React.JSX.Element {
  const { draft, mode } = props
  return (
    <header
      className={`flex shrink-0 items-center ${
        mode === 'inline' ? 'min-h-12 gap-3 py-2' : 'min-h-16 gap-4 pt-6 pb-2'
      }`}
      data-testid={mode === 'inline' ? 'composer-inline-header' : undefined}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <h1
          className={`${mode === 'inline' ? 'text-sm' : 'text-base'} font-semibold tracking-tight text-ink`}
        >
          {mode === 'inline'
            ? draft.kind === 'forward'
              ? 'Forward draft'
              : 'Reply draft'
            : composerTitle(draft.kind)}
        </h1>
        {mode === 'inline' && (
          <span
            data-testid="composer-not-sent"
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] font-normal text-accent"
          >
            Not sent
          </span>
        )}
        {mode === 'inline' && <ComposerSaveStatus {...props} />}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {mode === 'full' && (
          <Button
            data-testid="composer-close"
            aria-label="Save and close draft"
            data-tooltip=""
            disabled={props.attaching || props.closing}
            onClick={props.closeAndSave}
          >
            Save &amp; close <Kbd>Esc</Kbd>
          </Button>
        )}
      </div>
    </header>
  )
}

export function ComposerEnvelope(props: ComposerEnvelopeProps): React.JSX.Element | null {
  const { draft, mode } = props
  const [editingRecipients, setEditingRecipients] = useState(draft.kind === 'forward')
  const senderRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(
    () => registerCommands([createCommand('composer.from', () => senderRef.current?.focus())]),
    []
  )
  const [senderEmail, setSenderEmail] = useState(draft.senderEmail ?? draft.accountId)
  const [identities, setIdentities] = useState<SendAsIdentity[]>([])
  useEffect(() => {
    let active = true
    void window.attn?.draft
      .sendAs(draft.accountId)
      .then((items) => {
        if (active) setIdentities(items)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [draft.accountId])
  const sender = (
    <div
      className="flex min-h-10 shrink-0 items-center border-b border-edge"
      data-testid="composer-from"
      data-email={senderEmail}
    >
      <span className="w-10 shrink-0 text-xs font-normal text-ink-dim">From</span>
      <SenderMenu
        identities={identities}
        email={senderEmail}
        triggerRef={senderRef}
        disabled={props.closing}
        onChange={(email) => {
          setSenderEmail(email)
          props.updateFields({ senderEmail: email })
        }}
      />
    </div>
  )

  const inline = mode === 'inline'
  const context = inline ? (
    <div className="flex min-h-9 flex-wrap items-center gap-2 text-xs text-ink-dim">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:text-ink"
        onClick={() => {
          if (editingRecipients) {
            const fields = [props.toFieldRef, props.ccFieldRef, props.bccFieldRef]
            const committed = fields.map((field) => field.current?.commitPending() ?? true)
            if (committed.some((valid) => !valid)) return
          }
          setEditingRecipients(!editingRecipients)
        }}
        aria-expanded={editingRecipients}
        data-testid="composer-recipient-summary"
      >
        ↩ {composerTitle(draft.kind)}{' '}
        {props.to.length > 0
          ? `to ${props.to.map((recipient) => recipient.name || recipient.email).join(', ')}`
          : '· Add recipients'}
      </button>
      <Button
        data-testid="composer-close"
        aria-label="Save and close draft"
        data-tooltip=""
        disabled={props.attaching || props.closing}
        onClick={props.closeAndSave}
      >
        Save &amp; close <Kbd>Esc</Kbd>
      </Button>
      {!props.showCopies && (
        <Button
          data-testid="composer-show-copies"
          aria-label="Show Cc and Bcc fields"
          onClick={() => {
            setEditingRecipients(true)
            props.setShowCopies(true)
          }}
        >
          Cc Bcc
        </Button>
      )}
    </div>
  ) : null
  const notices = (
    <>
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
  if (inline && !editingRecipients)
    return (
      <>
        {context}
        {sender}
        {notices}
      </>
    )
  return (
    <>
      {context}
      {sender}
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
        {!inline && !props.showCopies && (
          <button
            type="button"
            className="absolute right-0 top-1.5 inline-flex h-7 items-center gap-2 rounded-md px-2 text-xs text-ink-dim hover:bg-active hover:text-ink"
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
      {notices}
      {mode === 'full' && (
        <label className="flex min-h-14 shrink-0 items-center pt-3">
          <span className="sr-only">Subject</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-base font-semibold text-ink outline-none placeholder:font-normal placeholder:italic placeholder:text-ink-faint/60"
            data-testid="composer-subject"
            aria-label="Subject"
            placeholder="Add a subject"
            value={props.subject}
            onChange={(event) => {
              props.setSubject(event.target.value)
              props.updateFields({ subject: event.target.value })
            }}
          />
        </label>
      )}
    </>
  )
}
