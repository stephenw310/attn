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
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import { $createQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $nodesOfType,
  FORMAT_TEXT_COMMAND
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MailAddress } from '../../../shared/address'
import type { Draft } from '../../../shared/drafts'
import { createCommand, matchComposerKey, registerCommands } from '../commands'
import { Kbd } from '../components/Kbd'
import { DraftContentIdContext } from './DraftContentContext'
import { EditorToolbar } from './EditorToolbar'
import { editorConfig } from './editorConfig'
import { $createImageNode, ImageNode } from './nodes/ImageNode'
import { prepareHtmlForEditor } from './preserve'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import { sanitizeOutgoingHtml } from './sanitize'
import { useComposerDraft } from './useComposerDraft'

interface ComposerProps {
  draft: Draft
  initialError?: string | null
  onClose: () => void
  onToast: (message: string, durationMs?: number) => void
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

function PaperclipIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <title>Attach files</title>
      <path
        d="m8.5 12.5 6.2-6.2a3 3 0 0 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function attachmentErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Each attachment must be 25 MB or less')) {
    return 'Each attachment must be 25 MB or less'
  }
  if (message.includes('Attachments must total 25 MB or less')) {
    return 'Attachments must total 25 MB or less'
  }
  if (message.includes('Only files can be attached')) return 'Only files can be attached'
  return 'Could not attach file'
}

function composerTitle(kind: Draft['kind']): string {
  if (kind === 'reply') return 'Reply'
  if (kind === 'replyAll') return 'Reply all'
  if (kind === 'forward') return 'Forward'
  return 'New message'
}

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plainTextForEditor(value: string): string {
  if (!value) return ''
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>`
}

function quoteSrcDoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;color:#6f7684;font:13px/1.55 Arial,sans-serif}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`
}

function quoteBodyWithCidPlaceholders(html: string): string {
  const document = new DOMParser().parseFromString(sanitizeOutgoingHtml(html), 'text/html')
  for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
    if ((image.getAttribute('src') ?? '').toLowerCase().startsWith('cid:')) {
      image.setAttribute('src', TRANSPARENT_IMAGE)
    }
  }
  return document.body.innerHTML
}

function CollapsedQuote({ draftId, html }: { draftId: string; html: string }): React.JSX.Element | null {
  const [srcDoc, setSrcDoc] = useState(() => quoteSrcDoc(quoteBodyWithCidPlaceholders(html)))
  useEffect(() => {
    if (!html) return
    let cancelled = false
    const document = new DOMParser().parseFromString(sanitizeOutgoingHtml(html), 'text/html')
    const pending = [...document.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
      const source = image.getAttribute('src') ?? ''
      if (!source.toLowerCase().startsWith('cid:') || !window.attn) return []
      const contentId = source.slice(4)
      image.setAttribute('src', TRANSPARENT_IMAGE)
      return [{ contentId, image }]
    })
    setSrcDoc(quoteSrcDoc(document.body.innerHTML))
    void Promise.all(
      pending.map(async ({ contentId, image }) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        if (result && 'dataUrl' in result) image.setAttribute('src', result.dataUrl)
      })
    ).then(() => {
      if (!cancelled) setSrcDoc(quoteSrcDoc(document.body.innerHTML))
    })
    return () => {
      cancelled = true
    }
  }, [draftId, html])
  if (!html) return null
  return (
    <details className="mx-5 mb-4 rounded-md border border-edge bg-canvas/40 px-3 py-2 text-xs text-ink-faint">
      <summary className="cursor-pointer select-none" data-testid="composer-quote-toggle">
        Quoted history
      </summary>
      <iframe
        title="Quoted history"
        sandbox=""
        data-testid="composer-quote"
        className="mt-2 h-48 w-full border-0 bg-white"
        srcDoc={srcDoc}
      />
    </details>
  )
}

function InitialHtmlPlugin({ draftId, html }: { draftId: string; html: string }): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    if (!html) return
    let cancelled = false
    const document = new DOMParser().parseFromString(html, 'text/html')
    const contentIds = [...document.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
      const source = image.getAttribute('src') ?? ''
      if (!source.toLowerCase().startsWith('cid:') || !window.attn) return []
      const contentId = source.slice(4)
      image.setAttribute('src', TRANSPARENT_IMAGE)
      image.setAttribute('data-attn-cid', contentId)
      return [contentId]
    })
    editor.update(
      () => {
        const nodes = $generateNodesFromDOM(editor, document)
        const root = $getRoot()
        root.clear()
        root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]))
      },
      { tag: 'attn-initial-html' }
    )
    void Promise.all(
      contentIds.map(async (contentId) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        return [contentId, result && 'dataUrl' in result ? result.dataUrl : TRANSPARENT_IMAGE] as const
      })
    ).then((resolved) => {
      if (cancelled) return
      const sources = new Map(resolved)
      editor.update(
        () => {
          for (const image of $nodesOfType(ImageNode)) {
            const source = sources.get(image.getContentId())
            if (source) image.setSrc(source)
          }
        },
        { tag: 'attn-inline-image-load' }
      )
    })
    return () => {
      cancelled = true
    }
  }, [draftId, editor, html])
  return null
}

function imageAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'))
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.readAsDataURL(file)
  })
}

function PasteContentPlugin({
  draftId,
  onAttachment,
  onError,
  onPreservedContent
}: {
  draftId: string
  onAttachment: (attachment: Draft['attachments'][number]) => void
  onError: (message: string) => void
  onPreservedContent: () => void
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(
    () =>
      editor.registerRootListener((root, previous) => {
        const onPaste = (event: ClipboardEvent): void => {
          const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
            file.type.startsWith('image/')
          )
          if (files.length > 0 && window.attn) {
            event.preventDefault()
            event.stopPropagation()
            void (async () => {
              for (const file of files) {
                try {
                  const dataBase64 = await imageAsBase64(file)
                  const { attachment, dataUrl } = await window.attn.draft.addInlineImage(draftId, {
                    filename: file.name || 'pasted-image',
                    mimeType: file.type,
                    dataBase64
                  })
                  onAttachment(attachment)
                  editor.update(() => {
                    $insertNodes([$createImageNode(dataUrl, attachment.contentId ?? '', attachment.filename)])
                  })
                } catch (error) {
                  onError(error instanceof Error ? error.message : 'Could not paste image')
                }
              }
            })()
            return
          }

          const html = event.clipboardData?.getData('text/html') ?? ''
          if (!html) return
          event.preventDefault()
          event.stopPropagation()
          void (async () => {
            const prepared = prepareHtmlForEditor(html)
            if (prepared.issues.length > 0) onPreservedContent()
            const document = new DOMParser().parseFromString(prepared.html, 'text/html')
            for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
              const source = image.getAttribute('src') ?? ''
              if (!source.toLowerCase().startsWith('data:')) continue
              const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(source)
              if (!match || !window.attn) {
                image.remove()
                continue
              }
              try {
                const result = await window.attn.draft.addInlineImage(draftId, {
                  filename: image.getAttribute('alt') || 'pasted-image',
                  mimeType: match[1],
                  dataBase64: match[2].replace(/\s/g, '')
                })
                onAttachment(result.attachment)
                image.setAttribute('src', result.dataUrl)
                image.setAttribute('data-attn-cid', result.attachment.contentId ?? '')
              } catch (error) {
                image.remove()
                onError(error instanceof Error ? error.message : 'Could not paste image')
              }
            }
            editor.update(() => $insertNodes($generateNodesFromDOM(editor, document)))
          })()
        }
        previous?.removeEventListener('paste', onPaste, true)
        root?.addEventListener('paste', onPaste, true)
      }),
    [draftId, editor, onAttachment, onError, onPreservedContent]
  )
  return null
}

interface CommandPluginProps {
  onAttach: () => void
  onClose: () => void
  onDiscard: () => void
  onSend: () => void
}

function ComposerCommandPlugin({ onAttach, onClose, onDiscard, onSend }: CommandPluginProps): null {
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
        createCommand('composer.send', onSend),
        createCommand('composer.attach', onAttach),
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
    [editor, onAttach, onClose, onDiscard, onSend, quote]
  )
  return null
}

export function Composer({ draft, initialError = null, onClose, onToast }: ComposerProps): React.JSX.Element {
  const [to, setTo] = useState<MailAddress[]>(draft.to)
  const [cc, setCc] = useState<MailAddress[]>(draft.cc)
  const [bcc, setBcc] = useState<MailAddress[]>(draft.bcc)
  const [attachments, setAttachments] = useState(draft.attachments)
  const [attaching, setAttaching] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [subject, setSubject] = useState(draft.subject)
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [closing, setClosing] = useState(false)
  const [sendError, setSendError] = useState<string | null>(initialError)
  const initialHtml = draft.bodyHtml || plainTextForEditor(draft.bodyText)
  const preparedHtml = useMemo(() => prepareHtmlForEditor(initialHtml), [initialHtml])
  const [hasPreservedContent, setHasPreservedContent] = useState(preparedHtml.issues.length > 0)
  const notePreservedContent = useCallback(() => setHasPreservedContent(true), [])
  const attachmentMutationRef = useRef(false)
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
  const addAttachment = useCallback(
    (attachment: Draft['attachments'][number]) => {
      setAttachments((current) => {
        const next = [...current, attachment]
        updateFields({ attachments: next })
        return next
      })
    },
    [updateFields]
  )
  const replaceAttachments = useCallback(
    (next: Draft['attachments']) => {
      setAttachments(next)
      updateFields({ attachments: next })
    },
    [updateFields]
  )
  const attach = useCallback(
    (request: () => Promise<{ attachments: Draft['attachments'] }>) => {
      if (closing || attachmentMutationRef.current) return
      attachmentMutationRef.current = true
      setAttaching(true)
      void request()
        .then((result) => replaceAttachments(result.attachments))
        .catch((error: unknown) => onToast(attachmentErrorMessage(error)))
        .finally(() => {
          attachmentMutationRef.current = false
          setAttaching(false)
        })
    },
    [closing, onToast, replaceAttachments]
  )
  const pickAttachments = useCallback(() => {
    const bridge = window.attn
    if (!bridge) return
    attach(() => bridge.draft.pickAttachments(draft.id))
  }, [attach, draft.id])
  const addDroppedFiles = useCallback(
    (files: File[]) => {
      const bridge = window.attn
      if (!bridge || files.length === 0) return
      attach(() => bridge.draft.addDroppedFiles(draft.id, files))
    },
    [attach, draft.id]
  )
  const removeAttachment = useCallback(
    (attachmentId: string) => {
      if (!window.attn || closing || attachmentMutationRef.current) return
      attachmentMutationRef.current = true
      setAttaching(true)
      void window.attn.draft
        .removeAttachment(draft.id, attachmentId)
        .then((result) => replaceAttachments(result.attachments))
        .catch(() => onToast('Could not remove attachment'))
        .finally(() => {
          attachmentMutationRef.current = false
          setAttaching(false)
        })
    },
    [closing, draft.id, onToast, replaceAttachments]
  )

  const visibleAttachments = attachments.filter((attachment) => !attachment.inline)

  const closeAndSave = useCallback(() => {
    if (closing || attachmentMutationRef.current || !window.attn) return
    if (!commitPendingRecipients()) {
      onToast('Enter a valid recipient before closing')
      return
    }
    setClosing(true)
    void saveNow()
      .then(() => window.attn.draft.close(draft.id))
      .then((result) => {
        onClose()
        onToast(result === 'saved' ? 'Draft saved' : 'Empty draft discarded')
      })
      .catch(() => {
        setClosing(false)
        onToast('Draft could not be saved — retrying')
      })
  }, [closing, commitPendingRecipients, draft.id, onClose, onToast, saveNow])

  const send = useCallback(() => {
    if (closing || !window.attn) return
    setSendError(null)
    if (attachmentMutationRef.current) {
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
        onToast('Sent — Undo (Z)', Math.max(1_000, result.sendAt - Date.now()))
      })
      .catch((error: unknown) => {
        setClosing(false)
        const message = error instanceof Error ? error.message : String(error)
        setSendError(
          message.includes('at least one recipient')
            ? 'Add at least one recipient'
            : 'Message could not be queued — your draft is still here'
        )
      })
  }, [closing, commitPendingRecipients, draft.id, onClose, onToast, saveNow])

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
    if (closing || attachmentMutationRef.current || !window.attn) return
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
      className={`flex min-h-0 flex-1 flex-col bg-raised/35 ${draggingFiles ? 'ring-1 ring-inset ring-accent/70' : ''}`}
      data-draft-id={draft.id}
      data-draft-kind={draft.kind}
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
          className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink disabled:cursor-wait disabled:opacity-50"
          data-testid="composer-close"
          aria-label="Save draft and go back"
          disabled={attaching || closing}
          onClick={closeAndSave}
        >
          <span aria-hidden>←</span> Back
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h1 className="text-base font-bold tracking-tight text-ink">{composerTitle(draft.kind)}</h1>
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
              <TablePlugin />
              <LinkPlugin validateUrl={(url) => /^(?:https?:|mailto:)/i.test(url)} />
              <InitialHtmlPlugin draftId={draft.id} html={preparedHtml.html} />
              <OnChangePlugin
                ignoreSelectionChange
                onChange={(editorState, editor, tags) => captureEditor(editorState, editor, tags)}
              />
              <ComposerCommandPlugin
                onAttach={pickAttachments}
                onClose={closeAndSave}
                onDiscard={discard}
                onSend={send}
              />
              <PasteContentPlugin
                draftId={draft.id}
                onAttachment={addAttachment}
                onError={onToast}
                onPreservedContent={notePreservedContent}
              />
              <CollapsedQuote draftId={draft.id} html={draft.quoteHtml} />
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
            <footer className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-edge px-4">
              <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                <EditorToolbar />
                <button
                  type="button"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-ink disabled:cursor-wait disabled:opacity-50"
                  data-testid="composer-attach"
                  aria-label="Attach files"
                  title="Attach files"
                  disabled={attaching || closing}
                  onClick={pickAttachments}
                >
                  <PaperclipIcon />
                </button>
                {attachments.length > 0 && (
                  <div
                    className="shrink-0 border-l border-edge pl-3 text-xs text-ink-faint"
                    data-testid="composer-attachments"
                  >
                    {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-md text-ink-faint hover:bg-active hover:text-danger disabled:cursor-wait disabled:opacity-50"
                  data-testid="composer-discard"
                  aria-label="Discard draft"
                  title="Discard draft"
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
                  Send <span className="ml-1 opacity-65">⌘↵</span>
                </button>
              </div>
            </footer>
          </LexicalComposer>
        </DraftContentIdContext.Provider>
      </div>
    </section>
  )
}
