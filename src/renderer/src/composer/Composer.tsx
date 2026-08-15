import { $generateNodesFromDOM } from '@lexical/html'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  HISTORY_MERGE_TAG
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MailAddress } from '../../../shared/address'
import type { Draft } from '../../../shared/drafts'
import { createCommand, matchComposerKey, registerCommands } from '../commands'
import { Kbd } from '../components/Kbd'
import { EditorToolbar } from './EditorToolbar'
import { editorConfig } from './editorConfig'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import { useComposerDraft } from './useComposerDraft'

interface ComposerProps {
  draft: Draft
  onClose: () => void
  onToast: (message: string) => void
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
      <title>Discard draft</title>
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" strokeLinecap="round" />
    </svg>
  )
}

function InitialHtmlPlugin({ html }: { html: string }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (!html) return
    editor.update(
      () => {
        const document = new DOMParser().parseFromString(html, 'text/html')
        const nodes = $generateNodesFromDOM(editor, document)
        const root = $getRoot()
        root.clear()
        root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]))
      },
      { tag: HISTORY_MERGE_TAG }
    )
  }, [editor, html])
  return null
}

interface CommandPluginProps {
  onClose: () => void
  onDiscard: () => void
  onUnavailableSend: () => void
}

function ComposerCommandPlugin({ onClose, onDiscard, onUnavailableSend }: CommandPluginProps): null {
  const [editor] = useLexicalComposerContext()
  const quote = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createQuoteNode())
    })
  }, [editor])
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.close', onClose),
        createCommand('composer.discard', onDiscard),
        createCommand('composer.send', onUnavailableSend),
        createCommand('composer.bold', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')),
        createCommand('composer.italic', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')),
        createCommand('composer.underline', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')),
        createCommand('composer.bullets', () =>
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
        ),
        createCommand('composer.numbering', () =>
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
        ),
        createCommand('composer.quote', quote)
      ]),
    [editor, onClose, onDiscard, onUnavailableSend, quote]
  )
  return null
}

export function Composer({ draft, onClose, onToast }: ComposerProps): React.JSX.Element {
  const [to, setTo] = useState<MailAddress[]>(draft.to)
  const [cc, setCc] = useState<MailAddress[]>(draft.cc)
  const [bcc, setBcc] = useState<MailAddress[]>(draft.bcc)
  const [subject, setSubject] = useState(draft.subject)
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [closing, setClosing] = useState(false)
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

  const closeAndSave = useCallback(() => {
    if (closing || !window.attn) return
    if (!commitPendingRecipients()) {
      onToast('Enter a valid recipient before closing')
      return
    }
    setClosing(true)
    void saveNow()
      .then(() => window.attn.draft.close(draft.id))
      .then(() => {
        onClose()
        onToast('Draft saved')
      })
      .catch(() => {
        setClosing(false)
        onToast('Draft could not be saved — retrying')
      })
  }, [closing, commitPendingRecipients, draft.id, onClose, onToast, saveNow])

  const unavailableSend = useCallback(() => {
    onToast('Send is not available yet')
  }, [onToast])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = matchComposerKey(event)
      if (!command) return
      event.preventDefault()
      event.stopPropagation()
      command.run()
    }
    // The composer is full-window, but the persistent account control remains
    // outside its subtree. A bubble listener preserves Escape after that control
    // has handled and closed its own transient menu.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const discard = useCallback((): void => {
    if (closing || !window.attn) return
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
  }, [closing, draft.id, onClose, onToast])

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-raised/35"
      data-draft-id={draft.id}
      data-testid="composer"
      aria-label="New message"
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement | null
        if (event.key === 'Escape' && target?.closest('[data-composer-transient]')) return
        const command = matchComposerKey(event.nativeEvent)
        if (!command) return
        event.preventDefault()
        event.stopPropagation()
        command.run()
      }}
    >
      <header className="flex min-h-13 shrink-0 items-center gap-4 border-b border-edge px-6 py-2.5">
        <button
          type="button"
          className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
          data-testid="composer-close"
          aria-label="Save draft and go back"
          onClick={closeAndSave}
        >
          <span aria-hidden>←</span> Back
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h1 className="text-base font-bold tracking-tight text-ink">New message</h1>
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
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            save &amp; close <Kbd>Esc</Kbd>
          </span>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col border-x border-edge bg-raised">
        <div className="relative">
          <RecipientField
            ref={toFieldRef}
            field="to"
            label="To"
            recipients={to}
            autoFocus
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

        <LexicalComposer initialConfig={editorConfig}>
          <div className="relative min-h-48 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  className="min-h-full px-5 py-5 text-[15px] leading-7 text-ink outline-none"
                  data-testid="composer-editor"
                  aria-label="Message body"
                />
              }
              placeholder={
                <div className="pointer-events-none absolute left-5 top-5 text-[15px] leading-7 text-ink-faint">
                  Write a message…
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <ListPlugin />
            <LinkPlugin validateUrl={(url) => /^(?:https?:|mailto:)/i.test(url)} />
            <InitialHtmlPlugin html={draft.bodyHtml} />
            <OnChangePlugin
              ignoreSelectionChange
              onChange={(editorState, editor, tags) => captureEditor(editorState, editor, tags)}
            />
            <ComposerCommandPlugin
              onClose={closeAndSave}
              onDiscard={discard}
              onUnavailableSend={unavailableSend}
            />
          </div>
          <footer className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-edge px-4">
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
              <EditorToolbar />
              <div
                className="shrink-0 border-l border-edge pl-3 text-xs text-ink-faint"
                data-testid="composer-attachments"
              >
                Attachments coming soon
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="flex size-8 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-danger"
                data-testid="composer-discard"
                aria-label="Discard draft"
                title="Discard draft"
                onClick={discard}
              >
                <TrashIcon />
              </button>
              <button
                type="button"
                className="rounded-md bg-accent/20 px-3.5 py-2 text-xs font-semibold text-accent"
                title="Sending is implemented in T16"
                onClick={unavailableSend}
              >
                Send <span className="ml-1 opacity-65">⌘↵</span>
              </button>
            </div>
          </footer>
        </LexicalComposer>
      </div>
    </section>
  )
}
