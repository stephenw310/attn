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
import { forwardRef } from 'react'
import type { AiThreadMessage } from '../../../shared/ai'
import type { Draft } from '../../../shared/drafts'
import { safeUrl } from '../../../shared/html'
import type { ShowToast } from '../hooks/useToast'
import { AiAutocompletePlugin } from './AiAutocompletePlugin'
import { AiDraftPlugin } from './AiDraftPlugin'
import { BodyEditingShortcutsPlugin, ComposerCommandPlugin } from './bodyEditing'
import { ComposerBodyHintPlugin } from './ComposerBodyHintPlugin'
import { ComposerEnvelope, ComposerHeader, composerTitle } from './ComposerChrome'
import { ComposerFooter } from './ComposerFooter'
import { DraftContentIdContext, DraftSourceMessageIdContext } from './DraftContentContext'
import { editorConfig } from './editorConfig'
import { InitialHtmlPlugin } from './InitialHtmlPlugin'
import { InlineQuote } from './InlineQuote'
import { CollapsedSignaturePlugin } from './nodes/CollapsedSignaturePlugin'
import { PasteContentPlugin } from './PastePlugin'
import { recipientGreetingName } from './recipientGreeting'
import { SnippetsPlugin } from './SnippetsPlugin'
import { COMPOSER_LINK_SCHEMES } from './sanitize'
import { useComposerController } from './useComposerController'

interface ComposerProps {
  draft: Draft
  mode?: 'full' | 'inline'
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

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { draft, mode = 'full', initialError = null, onClose, onExit, onToast, aiDraft },
  ref
): React.JSX.Element {
  const {
    to,
    setTo,
    cc,
    setCc,
    bcc,
    setBcc,
    draggingFiles,
    setDraggingFiles,
    subject,
    setSubject,
    followUpAt,
    setFollowUpAt,
    followUpOpen,
    setFollowUpOpen,
    openFollowUp,
    showCopies,
    setShowCopies,
    closing,
    sendError,
    aiTipReady,
    preparedHtml,
    unifiedSignatureAndQuote,
    unifiedContentExpanded,
    revealUnifiedContent,
    hasPreservedContent,
    notePreservedContent,
    toFieldRef,
    ccFieldRef,
    bccFieldRef,
    captureEditor,
    localRevision,
    savedRevision,
    saveStatus,
    updateFields,
    notePendingRecipientChange,
    noteAiContentSettled,
    handleSnippetInserted,
    attaching,
    addAttachment,
    pickAttachments,
    addDroppedFiles,
    removeAttachment,
    removeLastAttachment,
    visibleAttachments,
    closeAndSave,
    runComposerKey,
    send,
    discard
  } = useComposerController({
    draft,
    mode,
    initialError,
    onClose,
    onExit,
    onToast,
    supportsAiDraft: Boolean(aiDraft) && (draft.kind === 'reply' || draft.kind === 'replyAll'),
    ref
  })

  return (
    <section
      className={`${
        mode === 'inline'
          ? 'app-inline-composer flex w-full flex-none flex-col border-y border-edge bg-raised/20'
          : 'flex min-h-0 flex-1 flex-col bg-raised/35 px-6 pb-6'
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
      <ComposerHeader
        draft={draft}
        mode={mode}
        attaching={attaching}
        closing={closing}
        localRevision={localRevision}
        savedRevision={savedRevision}
        saveStatus={saveStatus}
        closeAndSave={closeAndSave}
      />

      <div
        className={
          mode === 'inline'
            ? 'flex w-full flex-col'
            : 'mx-auto mt-3 flex min-h-0 w-full max-w-[900px] flex-1 flex-col rounded-xl border border-edge bg-raised shadow-composer'
        }
      >
        <ComposerEnvelope
          draft={draft}
          mode={mode}
          attaching={attaching}
          to={to}
          setTo={setTo}
          cc={cc}
          setCc={setCc}
          bcc={bcc}
          setBcc={setBcc}
          toFieldRef={toFieldRef}
          ccFieldRef={ccFieldRef}
          bccFieldRef={bccFieldRef}
          showCopies={showCopies}
          setShowCopies={setShowCopies}
          subject={subject}
          setSubject={setSubject}
          updateFields={updateFields}
          notePendingRecipientChange={notePendingRecipientChange}
          sendError={sendError}
          hasPreservedContent={hasPreservedContent}
        />

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
                {mode === 'inline' && draft.kind !== 'forward' && (
                  // Focus the reply where the user writes it. Lexical's default
                  // lands the caret at the end of the document — below the
                  // signature, inside the Attn footer — so the first keystroke
                  // typed into the footer instead of the body.
                  <AutoFocusPlugin defaultSelection="rootStart" />
                )}
                <OnChangePlugin ignoreSelectionChange onChange={captureEditor} />
                <ComposerCommandPlugin
                  onAttach={pickAttachments}
                  onRemoveAttachment={removeLastAttachment}
                  onClose={closeAndSave}
                  onDiscard={discard}
                  onSend={send}
                  onFollowUp={openFollowUp}
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
              <ComposerFooter
                visibleAttachments={visibleAttachments}
                attaching={attaching}
                closing={closing}
                removeAttachment={removeAttachment}
                pickAttachments={pickAttachments}
                followUpAt={followUpAt}
                followUpOpen={followUpOpen}
                setFollowUpOpen={setFollowUpOpen}
                setFollowUpAt={setFollowUpAt}
                updateFields={updateFields}
                discard={discard}
                send={send}
              />
            </LexicalComposer>
          </DraftSourceMessageIdContext.Provider>
        </DraftContentIdContext.Provider>
      </div>
    </section>
  )
})
