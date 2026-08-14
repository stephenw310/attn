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
      className="fixed bottom-10 right-5 z-40 flex max-h-[calc(100vh-72px)] w-[min(680px,calc(100vw-40px))] flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-[0_24px_80px_rgb(0_0_0/0.55)]"
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
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-edge bg-ground/60 px-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h2 className="text-sm font-semibold tracking-tight text-ink">New message</h2>
          <span className="text-[11px] text-ink-faint">
            {controller.saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-danger"
            data-testid="composer-discard"
            aria-label="Discard draft"
            onClick={discard}
          >
            Discard
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-lg leading-none text-ink-faint hover:bg-active hover:text-ink"
            data-testid="composer-close"
            aria-label="Save and close"
            onClick={closeAndSave}
          >
            ×
          </button>
        </div>
      </header>

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
            className="absolute right-4 top-2.5 text-[11px] text-ink-faint hover:text-ink"
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
        className="h-11 shrink-0 border-b border-edge bg-transparent px-4 text-sm font-medium text-ink outline-none placeholder:text-ink-faint"
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
        <div className="relative min-h-48 flex-1 overflow-y-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="min-h-48 px-4 py-3 text-sm leading-6 text-ink outline-none"
                data-testid="composer-editor"
                aria-label="Message body"
              />
            }
            placeholder={
              <div className="pointer-events-none absolute left-4 top-3 text-sm leading-6 text-ink-faint">
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
        <footer className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-t border-edge px-3">
          <div className="flex min-w-0 items-center gap-2">
            <EditorToolbar />
            <div
              className="border-l border-edge pl-2 text-xs text-ink-faint"
              data-testid="composer-attachments"
            >
              Attachments coming soon
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md bg-accent/20 px-3 py-1.5 text-xs font-semibold text-accent"
            title="Sending is implemented in T16"
            onClick={unavailableSend}
          >
            Send <span className="ml-1 opacity-65">⌘↵</span>
          </button>
        </footer>
      </LexicalComposer>
    </section>
  )
}
