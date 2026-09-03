import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin'
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { MailAddress } from '../../../shared/address'
import { AI_PROVIDER_PRESETS, type AiThreadMessage } from '../../../shared/ai'
import type { Draft } from '../../../shared/drafts'
import { errorMessage } from '../../../shared/error'
import { escapeHtmlText as escapeHtml, safeUrl } from '../../../shared/html'
import { type Snippet, subjectAfterSnippetInsert } from '../../../shared/snippets'
import { matchComposerKey } from '../commands'
import { Kbd } from '../components/Kbd'
import { formatBytes } from '../formatBytes'
import type { ShowToast } from '../hooks/useToast'
import { modKeyLabel } from '../platform'
import { AiAutocompletePlugin } from './AiAutocompletePlugin'
import { AiDraftPlugin } from './AiDraftPlugin'
import { BodyEditingShortcutsPlugin, ComposerCommandPlugin } from './bodyEditing'
import { ComposerBodyHintPlugin } from './ComposerBodyHintPlugin'
import { DraftContentIdContext, DraftSourceMessageIdContext } from './DraftContentContext'
import { EditorToolbar } from './EditorToolbar'
import { editorConfig } from './editorConfig'
import { FollowUpControl } from './FollowUpControl'
import { InitialHtmlPlugin } from './InitialHtmlPlugin'
import { InlineQuote } from './InlineQuote'
import { CollapsedSignaturePlugin } from './nodes/CollapsedSignaturePlugin'
import { PasteContentPlugin } from './PastePlugin'
import { prepareHtmlForEditor } from './preserve'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import { recipientGreetingName } from './recipientGreeting'
import { SnippetsPlugin } from './SnippetsPlugin'
import { COMPOSER_LINK_SCHEMES } from './sanitize'
import { useComposerAttachments } from './useComposerAttachments'
import { useComposerDraft } from './useComposerDraft'

interface ComposerProps {
  draft: Draft
  mode?: 'full' | 'inline'
  attachedToMessage?: boolean
  initialError?: string | null
  onClose: () => void
  onExit?: () => void
  onToast: ShowToast
  /** T37 AI reply drafting: the invocation counter and reply context source. */
  aiDraft?: {
    request: number
    claim: () => boolean
    getThreadContext: () => AiThreadMessage[] | null
  }
}

export interface ComposerHandle {
  exitConversation: (afterExit?: () => void) => void
}

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

function PaperclipIcon({ title = 'Attachment' }: { title?: string }): React.JSX.Element {
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

function composerTitle(kind: Draft['kind']): string {
  if (kind === 'reply') return 'Reply'
  if (kind === 'replyAll') return 'Reply all'
  if (kind === 'forward') return 'Forward'
  return 'New message'
}

/**
 * Module scope on purpose. `LinkPlugin` re-registers its node transform
 * whenever this identity changes, and registering a transform runs it over the
 * whole document inside an `editor.update`. That update reconciles the DOM
 * selection back into the editor, so an inline arrow here pulls the caret out
 * of the recipient fields on every keystroke.
 */
function validateComposerUrl(url: string): boolean {
  return safeUrl(url, COMPOSER_LINK_SCHEMES) !== null
}

function plainTextForEditor(value: string): string {
  if (!value) return ''
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>`
}

function hasGmailSignature(html: string): boolean {
  if (!html) return false
  const document = new DOMParser().parseFromString(html, 'text/html')
  return document.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]') !== null
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { draft, mode = 'full', attachedToMessage = false, initialError = null, onClose, onExit, onToast, aiDraft },
  ref
): React.JSX.Element {
  const [to, setTo] = useState<MailAddress[]>(draft.to)
  const [cc, setCc] = useState<MailAddress[]>(draft.cc)
  const [bcc, setBcc] = useState<MailAddress[]>(draft.bcc)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [subject, setSubject] = useState(draft.subject)
  const [followUpAt, setFollowUpAt] = useState<number | null>(draft.followUpAt)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [closing, setClosing] = useState(false)
  const [sendError, setSendError] = useState<string | null>(initialError)
  const supportsAiDraft = Boolean(aiDraft) && (draft.kind === 'reply' || draft.kind === 'replyAll')
  const [aiTipReady, setAiTipReady] = useState(false)
  useEffect(() => {
    setAiTipReady(false)
    if (!supportsAiDraft || !window.attn) return
    let stale = false
    void window.attn.ai
      .getSettings()
      .then((settings) => {
        const keyReady = settings.keyPresent || !AI_PROVIDER_PRESETS[settings.provider].keyRequired
        if (!stale) setAiTipReady(settings.enabled && keyReady)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [supportsAiDraft])
  const initialHtml = draft.bodyHtml || plainTextForEditor(draft.bodyText)
  const preparedHtml = useMemo(() => prepareHtmlForEditor(initialHtml), [initialHtml])
  const unifiedSignatureAndQuote = useMemo(
    () => Boolean(draft.quoteHtml) && hasGmailSignature(preparedHtml.html),
    [draft.quoteHtml, preparedHtml.html]
  )
  const [unifiedContentExpanded, setUnifiedContentExpanded] = useState(false)
  const revealUnifiedContent = useCallback(() => setUnifiedContentExpanded(true), [])
  const [hasPreservedContent, setHasPreservedContent] = useState(preparedHtml.issues.length > 0)
  const notePreservedContent = useCallback(() => setHasPreservedContent(true), [])
  const toFieldRef = useRef<RecipientFieldHandle | null>(null)
  const ccFieldRef = useRef<RecipientFieldHandle | null>(null)
  const bccFieldRef = useRef<RecipientFieldHandle | null>(null)

  const commitPendingRecipients = useCallback((reportInvalid = true) => {
    let valid = true
    for (const fieldRef of [toFieldRef, ccFieldRef, bccFieldRef]) {
      if (!(fieldRef.current?.commitPending(reportInvalid) ?? true)) valid = false
    }
    return valid
  }, [])
  const prepareSnapshot = useCallback(() => {
    commitPendingRecipients(false)
  }, [commitPendingRecipients])
  const { captureEditor, localRevision, savedRevision, saveNow, saveStatus, updateFields } = useComposerDraft(
    draft,
    prepareSnapshot
  )
  const notePendingRecipientChange = useCallback(() => updateFields({}), [updateFields])
  const noteAiContentSettled = useCallback(() => updateFields({}), [updateFields])
  // F8: a snippet's subject fills only an empty subject, never overwrites.
  const subjectRef = useRef(subject)
  subjectRef.current = subject
  const handleSnippetInserted = useCallback(
    (snippet: Snippet) => {
      const next = subjectAfterSnippetInsert(subjectRef.current, snippet.subject)
      if (next === subjectRef.current) return
      setSubject(next)
      updateFields({ subject: next })
    },
    [updateFields]
  )
  const noteAttachmentsChanged = useCallback(
    (attachments: Draft['attachments']) => updateFields({ attachments }),
    [updateFields]
  )
  const {
    attaching,
    isMutating: attachmentMutationInFlight,
    addAttachment,
    pickAttachments,
    addDroppedFiles,
    removeAttachment,
    removeLastAttachment,
    visibleAttachments
  } = useComposerAttachments({
    draftId: draft.id,
    initial: draft.attachments,
    closing,
    onToast,
    onFieldsChanged: noteAttachmentsChanged
  })

  const saveAndClose = useCallback(
    (afterClose: () => void) => {
      if (closing || !window.attn) return
      if (attachmentMutationInFlight()) {
        onToast('Wait for the current attachment change to finish')
        return
      }
      if (!commitPendingRecipients()) {
        onToast('Enter a valid recipient before closing')
        return
      }
      setClosing(true)
      void saveNow()
        .then(() => window.attn.draft.close(draft.id))
        .then((result) => {
          afterClose()
          onToast(result === 'saved' ? 'Draft saved' : 'Empty draft discarded')
        })
        .catch(() => {
          setClosing(false)
          onToast('Draft could not be saved — retrying')
        })
    },
    [attachmentMutationInFlight, closing, commitPendingRecipients, draft.id, onToast, saveNow]
  )

  const closeAndSave = useCallback(() => saveAndClose(onClose), [onClose, saveAndClose])
  const closeAndExit = useCallback(
    (afterExit?: () => void) =>
      saveAndClose(() => {
        const finishExit = onExit ?? onClose
        finishExit()
        afterExit?.()
      }),
    [onClose, onExit, saveAndClose]
  )

  const runComposerKey = useCallback(
    (event: KeyboardEvent): boolean => {
      const command = matchComposerKey(event)
      if (command) {
        command.run()
        return true
      }
      // The outer composer can be visible for one commit before Lexical's
      // command plugin registers. Keep its fundamental Escape behavior live
      // during that narrow window instead of dropping a fast close keystroke.
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const close = mode === 'inline' ? closeAndExit : closeAndSave
        close()
        return true
      }
      return false
    },
    [closeAndExit, closeAndSave, mode]
  )

  useImperativeHandle(ref, () => ({ exitConversation: closeAndExit }), [closeAndExit])

  const send = useCallback(() => {
    if (closing || !window.attn) return
    setSendError(null)
    if (attachmentMutationInFlight()) {
      setSendError('Wait for attachments to finish')
      return
    }
    if (!commitPendingRecipients()) {
      setSendError('Enter a valid recipient before sending')
      return
    }
    setClosing(true)
    void saveNow()
      .then(() => window.attn.outbox.send(draft.id))
      .then((result) => {
        onClose()
        onToast('Sent — Undo (Z)', { expiresAt: result.sendAt, countdown: true })
      })
      .catch((error: unknown) => {
        setClosing(false)
        const message = errorMessage(error)
        setSendError(
          message.includes('at least one recipient')
            ? 'Add at least one recipient'
            : 'Message could not be queued — your draft is still here'
        )
      })
  }, [attachmentMutationInFlight, closing, commitPendingRecipients, draft.id, onClose, onToast, saveNow])

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!runComposerKey(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    // The persistent account control remains outside the composer subtree. A
    // bubble listener preserves Escape after that control has handled and closed
    // its own transient menu, in both full-window and inline modes.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runComposerKey])

  const discard = useCallback((): void => {
    if (closing || !window.attn) return
    if (attachmentMutationInFlight()) {
      onToast('Wait for the current attachment change to finish')
      return
    }
    setClosing(true)
    void window.attn.draft
      .discard(draft.id)
      .then(() => {
        onClose()
        onToast('Draft discarded')
      })
      .catch(() => {
        setClosing(false)
        onToast('Draft could not be discarded')
      })
  }, [attachmentMutationInFlight, closing, draft.id, onClose, onToast])

  return (
    <section
      className={`${
        mode === 'inline'
          ? `flex w-full flex-none flex-col overflow-hidden border border-edge bg-raised ${attachedToMessage ? 'rounded-b-[10px]' : 'rounded-xl shadow-composer'}`
          : 'flex min-h-0 flex-1 flex-col bg-raised/35'
      } ${draggingFiles ? 'ring-1 ring-inset ring-accent/70' : ''}`}
      data-draft-id={draft.id}
      data-draft-kind={draft.kind}
      data-composer-mode={mode}
      data-testid="composer"
      aria-label={composerTitle(draft.kind)}
      data-dragging-files={draggingFiles ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDraggingFiles(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDraggingFiles(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDraggingFiles(false)
        addDroppedFiles([...event.dataTransfer.files])
      }}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement | null
        if (event.key === 'Escape' && target?.closest('[data-composer-transient]')) return
        if (!runComposerKey(event.nativeEvent)) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <header
        className={`flex shrink-0 items-center border-b border-edge ${
          mode === 'inline' ? 'min-h-12 gap-3 px-4 py-2' : 'min-h-13 gap-4 px-6 py-2.5'
        }`}
        data-testid={mode === 'inline' ? 'composer-inline-header' : undefined}
      >
        {mode === 'full' ? (
          <button
            type="button"
            className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink disabled:cursor-wait disabled:opacity-50"
            data-testid="composer-close"
            aria-label="Save draft and go back"
            disabled={attaching || closing}
            onClick={closeAndSave}
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
            data-local-revision={localRevision}
            data-saved-revision={savedRevision}
            data-save-status={saveStatus}
          >
            {saveStatus === 'saving'
              ? 'Saving…'
              : saveStatus === 'unsaved'
                ? 'Unsaved changes'
                : saveStatus === 'error'
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
              className="flex size-7 items-center justify-center rounded-md text-lg text-ink-faint hover:bg-active hover:text-ink"
              data-testid="composer-close"
              aria-label="Save and close draft"
              title="Save and close draft (Esc)"
              onClick={closeAndSave}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div
        className={
          mode === 'inline'
            ? 'flex w-full flex-col bg-raised'
            : 'mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col border-x border-edge bg-raised'
        }
      >
        <div
          className="flex min-h-10 shrink-0 items-center border-b border-edge px-4"
          data-testid="composer-from"
          data-email={draft.accountId}
        >
          <span className="w-10 shrink-0 text-sm font-medium text-ink-faint">From</span>
          {/* The draft's owning account, bound at open — never the account that
              happens to be active (F6/F18). In every reachable flow they agree;
              rendering the binding is what makes a divergence visible. */}
          <span className="min-w-0 truncate text-sm text-ink">{draft.accountId}</span>
        </div>
        <div className="relative">
          <RecipientField
            ref={toFieldRef}
            field="to"
            label="To"
            recipients={to}
            autoFocus={mode === 'full' || draft.kind === 'forward'}
            onPendingChange={notePendingRecipientChange}
            onChange={(recipients) => {
              setTo(recipients)
              updateFields({ to: recipients })
            }}
          />
          {!showCopies && (
            <button
              type="button"
              className="absolute right-3 top-1.5 inline-flex h-7 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-ink-faint hover:border-edge hover:bg-active hover:text-ink"
              data-testid="composer-show-copies"
              aria-label="Show Cc and Bcc fields"
              aria-expanded="false"
              onClick={() => setShowCopies(true)}
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
        {showCopies && (
          <>
            <RecipientField
              ref={ccFieldRef}
              field="cc"
              label="Cc"
              recipients={cc}
              onPendingChange={notePendingRecipientChange}
              onChange={(recipients) => {
                setCc(recipients)
                updateFields({ cc: recipients })
              }}
            />
            <RecipientField
              ref={bccFieldRef}
              field="bcc"
              label="Bcc"
              recipients={bcc}
              onPendingChange={notePendingRecipientChange}
              onChange={(recipients) => {
                setBcc(recipients)
                updateFields({ bcc: recipients })
              }}
            />
          </>
        )}
        {mode === 'full' && (
          <input
            className="h-12 shrink-0 border-b border-edge bg-transparent px-4 text-sm font-medium text-ink outline-none placeholder:text-ink-faint"
            data-testid="composer-subject"
            aria-label="Subject"
            placeholder="Subject"
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value)
              updateFields({ subject: event.target.value })
            }}
          />
        )}

        {sendError && (
          <div
            data-testid="composer-send-error"
            className="border-b border-danger/35 bg-danger/10 px-4 py-2 text-xs text-danger"
          >
            {sendError}
          </div>
        )}

        {attaching && (
          <div className="h-0.5 shrink-0 overflow-hidden bg-edge" data-testid="composer-attach-progress">
            <div className="app-attachment-progress h-full w-1/3 bg-accent" />
          </div>
        )}

        {hasPreservedContent && (
          <div
            data-testid="composer-preserved-banner"
            className="border-b border-edge bg-accent/[0.06] px-4 py-2 text-xs text-ink-dim"
          >
            Some formatting is preserved as read-only content and will be sent unchanged.
          </div>
        )}

        <DraftContentIdContext.Provider value={draft.id}>
          <DraftSourceMessageIdContext.Provider value={draft.sourceMessageId}>
            <LexicalComposer initialConfig={editorConfig}>
              <div
                className={`relative min-h-48 flex-1 ${
                  mode === 'inline' ? '' : 'overflow-y-auto [scrollbar-gutter:stable]'
                }`}
              >
                <RichTextPlugin
                  contentEditable={
                    <ContentEditable
                      className="min-h-full px-5 py-5 text-[13px] leading-5 text-ink outline-none"
                      data-testid="composer-editor"
                      aria-label="Message body"
                    />
                  }
                  placeholder={
                    aiTipReady ? null : (
                      <div className="pointer-events-none absolute left-5 top-5 text-[13px] leading-5 text-ink-faint">
                        Write a message…
                      </div>
                    )
                  }
                  ErrorBoundary={LexicalErrorBoundary}
                />
                <HistoryPlugin />
                <BodyEditingShortcutsPlugin />
                <ListPlugin />
                <TablePlugin />
                <LinkPlugin validateUrl={validateComposerUrl} />
                <ClickableLinkPlugin newTab />
                <InitialHtmlPlugin draftId={draft.id} html={preparedHtml.html} />
                <CollapsedSignaturePlugin
                  includesQuote={unifiedSignatureAndQuote}
                  onReveal={revealUnifiedContent}
                />
                {mode === 'inline' && draft.kind !== 'forward' && <AutoFocusPlugin />}
                <OnChangePlugin ignoreSelectionChange onChange={captureEditor} />
                <ComposerCommandPlugin
                  onAttach={pickAttachments}
                  onRemoveAttachment={removeLastAttachment}
                  onClose={mode === 'inline' ? closeAndExit : closeAndSave}
                  onDiscard={discard}
                  onSend={send}
                  onFollowUp={() => setFollowUpOpen(true)}
                />
                <PasteContentPlugin
                  draftId={draft.id}
                  onAttachment={addAttachment}
                  onError={onToast}
                  onPreservedContent={notePreservedContent}
                />
                <SnippetsPlugin onInserted={handleSnippetInserted} />
                <ComposerBodyHintPlugin showAiTip={aiTipReady} />
                <AiAutocompletePlugin
                  subject={subject}
                  recipientName={recipientGreetingName(to[0])}
                  getThreadContext={aiDraft?.getThreadContext}
                />
                {aiDraft && (
                  <AiDraftPlugin
                    kind={draft.kind}
                    threadId={draft.threadId}
                    request={aiDraft.request}
                    claim={aiDraft.claim}
                    getThreadContext={aiDraft.getThreadContext}
                    onContentSettled={noteAiContentSettled}
                    onToast={onToast}
                  />
                )}
                <InlineQuote
                  draftId={draft.id}
                  html={draft.quoteHtml}
                  sourceMessageId={draft.sourceMessageId}
                  expanded={unifiedSignatureAndQuote ? unifiedContentExpanded : undefined}
                  showToggle={!unifiedSignatureAndQuote}
                />
              </div>
              {visibleAttachments.length > 0 && (
                <div
                  className="flex shrink-0 flex-wrap gap-2 border-t border-edge px-4 py-2.5"
                  data-testid="composer-attachment-chips"
                >
                  {visibleAttachments.map((attachment) => (
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
                        disabled={attaching || closing}
                        onClick={() => removeAttachment(attachment.id)}
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
                    disabled={attaching || closing}
                    onClick={pickAttachments}
                  >
                    <PaperclipIcon title={`Attach files (${modKeyLabel()}⇧A)`} />
                  </button>
                  {visibleAttachments.length > 0 && (
                    <div
                      className="shrink-0 border-l border-edge pl-3 text-xs text-ink-faint"
                      data-testid="composer-attachments"
                    >
                      {visibleAttachments.length} attachment{visibleAttachments.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <FollowUpControl
                    followUpAt={followUpAt}
                    open={followUpOpen}
                    onOpenChange={setFollowUpOpen}
                    onChange={(value) => {
                      setFollowUpAt(value)
                      updateFields({ followUpAt: value })
                    }}
                  />
                  <button
                    type="button"
                    className="flex size-8 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-danger disabled:cursor-wait disabled:opacity-50"
                    data-testid="composer-discard"
                    aria-label="Discard draft"
                    title={`Discard draft (${modKeyLabel()}⇧D)`}
                    disabled={attaching || closing}
                    onClick={discard}
                  >
                    <TrashIcon />
                  </button>
                  <button
                    type="button"
                    data-testid="composer-send"
                    disabled={attaching || closing}
                    className="cursor-pointer rounded-md bg-accent/20 px-3.5 py-2 text-xs font-semibold text-accent disabled:cursor-wait disabled:opacity-50"
                    title="Send message"
                    onClick={send}
                  >
                    Send <span className="ml-1 opacity-65">{modKeyLabel()}↵</span>
                  </button>
                </div>
              </footer>
            </LexicalComposer>
          </DraftSourceMessageIdContext.Provider>
        </DraftContentIdContext.Provider>
      </div>
    </section>
  )
})
