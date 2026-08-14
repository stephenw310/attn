import { $generateNodesFromDOM } from '@lexical/html'
import { TOGGLE_LINK_COMMAND } from '@lexical/link'
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
  FORMAT_TEXT_COMMAND
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { MailAddress } from '../../../shared/address'
import type { Draft } from '../../../shared/drafts'
import { createCommand, registerCommands } from '../commands'
import { Kbd } from '../components/Kbd'
import { EditorToolbar, promptForLink } from './EditorToolbar'
import { editorConfig } from './editorConfig'
import { RecipientField } from './RecipientField'
import { useComposerDraft } from './useComposerDraft'

interface ComposerProps {
  draft: Draft
  onClose: () => void
  onToast: (message: string) => void
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
      { tag: 'draft-initial' }
    )
  }, [editor, html])
  return null
}

interface CommandPluginProps {
  onClose: () => void
  onUnavailableSend: () => void
}

function ComposerCommandPlugin({ onClose, onUnavailableSend }: CommandPluginProps): null {
  const [editor] = useLexicalComposerContext()
  const quote = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createQuoteNode())
    })
  }, [editor])
  const link = useCallback(() => {
    const url = promptForLink()
    if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
  }, [editor])

  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.close', onClose),
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
        createCommand('composer.quote', quote),
        createCommand('composer.link', link)
      ]),
    [editor, link, onClose, onUnavailableSend, quote]
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
  const controller = useComposerDraft(draft)

  const closeAndSave = useCallback(() => {
    if (closing) return
    setClosing(true)
    void controller
      .saveNow()
      .then(() => {
        onClose()
        onToast('Draft saved')
      })
      .catch(() => setClosing(false))
  }, [closing, controller, onClose, onToast])

  const unavailableSend = useCallback(() => {
    onToast('Send is not available yet')
  }, [onToast])

  const discard = (): void => {
    if (closing || !window.attn) return
    setClosing(true)
    void window.attn.draft
      .discard(draft.id)
      .then(() => {
        onClose()
        onToast('Draft discarded')
      })
      .catch(() => setClosing(false))
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-raised/35"
      data-testid="composer"
      aria-label="New message"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeAndSave()
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          unavailableSend()
        }
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
          <span className="text-[11px] text-ink-faint">
            {controller.saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-danger"
            data-testid="composer-discard"
            aria-label="Discard draft"
            onClick={discard}
          >
            Discard
          </button>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            save &amp; close <Kbd>Esc</Kbd>
          </span>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col border-x border-edge bg-raised">
        <div className="relative">
          <RecipientField
            field="to"
            label="To"
            recipients={to}
            autoFocus
            onChange={(recipients) => {
              setTo(recipients)
              controller.updateFields({ to: recipients })
            }}
          />
          {!showCopies && (
            <button
              type="button"
              className="absolute right-5 top-2.5 text-[11px] text-ink-faint hover:text-ink"
              onClick={() => setShowCopies(true)}
            >
              Cc Bcc
            </button>
          )}
        </div>
        {showCopies && (
          <>
            <RecipientField
              field="cc"
              label="Cc"
              recipients={cc}
              onChange={(recipients) => {
                setCc(recipients)
                controller.updateFields({ cc: recipients })
              }}
            />
            <RecipientField
              field="bcc"
              label="Bcc"
              recipients={bcc}
              onChange={(recipients) => {
                setBcc(recipients)
                controller.updateFields({ bcc: recipients })
              }}
            />
          </>
        )}
        <input
          className="h-12 shrink-0 border-b border-edge bg-transparent px-5 text-base font-semibold text-ink outline-none placeholder:text-ink-faint"
          data-testid="composer-subject"
          aria-label="Subject"
          placeholder="Subject"
          value={subject}
          onChange={(event) => {
            setSubject(event.target.value)
            controller.updateFields({ subject: event.target.value })
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
              onChange={(editorState, editor, tags) => controller.captureEditor(editorState, editor, tags)}
            />
            <ComposerCommandPlugin onClose={closeAndSave} onUnavailableSend={unavailableSend} />
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
            <button
              type="button"
              className="shrink-0 rounded-md bg-accent/20 px-3.5 py-2 text-xs font-semibold text-accent"
              title="Sending is implemented in T16"
              onClick={unavailableSend}
            >
              Send <span className="ml-1 opacity-65">⌘↵</span>
            </button>
          </footer>
        </LexicalComposer>
      </div>
    </section>
  )
}
