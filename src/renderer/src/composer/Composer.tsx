import { $generateNodesFromDOM } from '@lexical/html'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin'
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
import type { Draft } from '../../../shared/drafts'
import { createCommand, matchComposerKey, registerCommands } from '../commands'
import { Kbd } from '../components/Kbd'
import { type MailSurface, mailSurfaceForHtml, normalizeNativeMailDocument } from '../mailSurface'
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
  mode?: 'full' | 'inline'
  onClose: () => void
  onExit?: () => void
  onToast: (message: string) => void
}

export interface ComposerHandle {
  exitConversation: () => void
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

function composerTitle(kind: Draft['kind']): string {
  if (kind === 'reply') return 'Reply'
  if (kind === 'replyAll') return 'Reply all'
  if (kind === 'forward') return 'Forward'
  return 'New message'
}

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const QUOTE_MAX_HEIGHT = 720

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plainTextForEditor(value: string): string {
  if (!value) return ''
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>`
}

function quoteSrcDoc(body: string, surface: MailSurface): string {
  const light = surface === 'light'
  const nativeContrast = light
    ? ''
    : 'body,body :where(*){color:inherit!important;background-color:transparent!important;background-image:none!important}body a{color:#60a5fa!important}'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${light ? 'light' : 'dark'}"><base target="_blank"><style>:root{color-scheme:${light ? 'light' : 'dark'}}html,body{box-sizing:border-box;margin:0;background:${light ? '#fff' : 'transparent'}!important}html{padding:0;overflow-x:auto;overflow-y:auto}body{padding:${light ? '12px' : '0'};color:${light ? '#202124' : '#939baa'};font:${light ? '14px/1.6' : '15px/1.7'} Arial,Helvetica,sans-serif;overflow-wrap:break-word}blockquote{margin:.35rem 0 0;border-left:1px solid ${light ? '#dadce0' : '#555d69'};padding-left:1rem}p:first-child{margin-top:0}p:last-child{margin-bottom:0}a{color:${light ? '#1a73e8' : '#d7a13c'}}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}${nativeContrast}</style></head><body>${body}</body></html>`
}

function InlineQuote({ draftId, html }: { draftId: string; html: string }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const surface = useMemo(() => mailSurfaceForHtml(html), [html])
  const [srcDoc, setSrcDoc] = useState(() => quoteSrcDoc('', surface))
  const [height, setHeight] = useState(1)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)

  const forwardKey = useCallback((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Tab') return
    const target = event.target as HTMLElement | null
    if (event.key === 'Enter' && target?.closest?.('a, button, input, textarea, select')) return
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true
    })
    ;(frameRef.current ?? document.body).dispatchEvent(forwarded)
    if (forwarded.defaultPrevented) event.preventDefault()
  }, [])

  const disconnect = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    keyDocumentRef.current?.removeEventListener('keydown', forwardKey)
    keyDocumentRef.current = null
  }, [forwardKey])

  const measure = useCallback((frame: HTMLIFrameElement) => {
    const document = frame.contentDocument
    if (!document?.body) return
    const next = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1)
    setHeight(Math.min(next, QUOTE_MAX_HEIGHT))
  }, [])

  const observe = useCallback(
    (frame: HTMLIFrameElement) => {
      const document = frame.contentDocument
      if (!document?.body) return
      disconnect()
      measure(frame)
      const observer = new ResizeObserver(() => measure(frame))
      observer.observe(document.body)
      observerRef.current = observer
      document.addEventListener('keydown', forwardKey)
      keyDocumentRef.current = document
    },
    [disconnect, forwardKey, measure]
  )

  useEffect(() => {
    if (!html) return
    let cancelled = false
    const document = new DOMParser().parseFromString(sanitizeOutgoingHtml(html), 'text/html')
    if (surface === 'native') normalizeNativeMailDocument(document.body)
    const pending = [...document.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
      const source = image.getAttribute('src') ?? ''
      if (!source.toLowerCase().startsWith('cid:') || !window.attn) return []
      const contentId = source.slice(4)
      image.setAttribute('src', TRANSPARENT_IMAGE)
      return [{ contentId, image }]
    })
    setSrcDoc(quoteSrcDoc(document.body.innerHTML, surface))
    void Promise.all(
      pending.map(async ({ contentId, image }) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        if (result && 'dataUrl' in result) image.setAttribute('src', result.dataUrl)
      })
    ).then(() => {
      if (!cancelled) setSrcDoc(quoteSrcDoc(document.body.innerHTML, surface))
    })
    return () => {
      cancelled = true
    }
  }, [draftId, html, surface])

  const renderedQuote = expanded ? srcDoc : null
  useLayoutEffect(() => {
    if (!renderedQuote) {
      disconnect()
      return
    }
    setHeight(1)
    let frameId = 0
    const waitForSrcDoc = (): void => {
      const frame = frameRef.current
      if (frame?.contentWindow?.location.href === 'about:srcdoc' && frame.contentDocument?.body) {
        observe(frame)
        return
      }
      frameId = requestAnimationFrame(waitForSrcDoc)
    }
    frameId = requestAnimationFrame(waitForSrcDoc)
    return () => {
      cancelAnimationFrame(frameId)
      disconnect()
    }
  }, [disconnect, observe, renderedQuote])

  if (!html) return null
  return (
    <div className="mx-5 mb-5 text-sm text-ink-dim" data-testid="composer-quote-container">
      {/* `allow-same-origin` is needed only to measure this scriptless srcdoc,
          resolve CID images, and forward keyboard events to the app shell. */}
      {expanded && (
        <iframe
          ref={frameRef}
          title="Quoted history"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          data-testid="composer-quote"
          data-surface={surface}
          className={`block w-full border-0 ${surface === 'light' ? 'bg-white' : 'bg-transparent'}`}
          srcDoc={srcDoc}
          onLoad={(event) => observe(event.currentTarget)}
          style={{ colorScheme: surface === 'light' ? 'light' : 'dark', height }}
        />
      )}
      <button
        type="button"
        className={`${expanded ? 'mt-1' : ''} block cursor-pointer border-0 bg-transparent px-0.5 text-sm font-normal tracking-normal text-ink-faint hover:text-ink`}
        data-testid="composer-quote-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide quoted history' : 'Show quoted history'}
        title={expanded ? 'Hide quoted history' : 'Show quoted history'}
        onClick={() => setExpanded((current) => !current)}
      >
        ...
      </button>
    </div>
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

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { draft, mode = 'full', onClose, onExit, onToast },
  ref
): React.JSX.Element {
  const [to, setTo] = useState<MailAddress[]>(draft.to)
  const [cc, setCc] = useState<MailAddress[]>(draft.cc)
  const [bcc, setBcc] = useState<MailAddress[]>(draft.bcc)
  const [attachments, setAttachments] = useState(draft.attachments)
  const [subject, setSubject] = useState(draft.subject)
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0)
  const [closing, setClosing] = useState(false)
  const initialHtml = draft.bodyHtml || plainTextForEditor(draft.bodyText)
  const preparedHtml = useMemo(() => prepareHtmlForEditor(initialHtml), [initialHtml])
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

  const saveAndClose = useCallback(
    (afterClose: () => void) => {
      if (closing || !window.attn) return
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
    [closing, commitPendingRecipients, draft.id, onToast, saveNow]
  )

  const closeAndSave = useCallback(() => saveAndClose(onClose), [onClose, saveAndClose])
  const closeAndExit = useCallback(() => saveAndClose(onExit ?? onClose), [onClose, onExit, saveAndClose])

  useImperativeHandle(ref, () => ({ exitConversation: closeAndExit }), [closeAndExit])

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
    // The persistent account control remains outside the composer subtree. A
    // bubble listener preserves Escape after that control has handled and closed
    // its own transient menu, in both full-window and inline modes.
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
      className={
        mode === 'inline'
          ? 'flex w-full flex-none flex-col overflow-hidden rounded-xl border border-edge bg-raised shadow-[0_18px_44px_rgba(0,0,0,0.24)]'
          : 'flex min-h-0 flex-1 flex-col bg-raised/35'
      }
      data-draft-id={draft.id}
      data-draft-kind={draft.kind}
      data-composer-mode={mode}
      data-testid="composer"
      aria-label={composerTitle(draft.kind)}
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
      <header
        className={`flex shrink-0 items-center border-b border-edge ${
          mode === 'inline' ? 'min-h-12 gap-3 px-4 py-2' : 'min-h-13 gap-4 px-6 py-2.5'
        }`}
        data-testid={mode === 'inline' ? 'composer-inline-header' : undefined}
      >
        {mode === 'full' ? (
          <button
            type="button"
            className="app-no-drag flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink"
            data-testid="composer-close"
            aria-label="Save draft and go back"
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
            <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              save &amp; close <Kbd>Esc</Kbd>
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
            <div
              className={`relative min-h-48 flex-1 ${
                mode === 'inline' ? '' : 'overflow-y-auto [scrollbar-gutter:stable]'
              }`}
            >
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
              {mode === 'inline' && draft.kind !== 'forward' && <AutoFocusPlugin />}
              <OnChangePlugin
                ignoreSelectionChange
                onChange={(editorState, editor, tags) => captureEditor(editorState, editor, tags)}
              />
              <ComposerCommandPlugin
                onClose={mode === 'inline' ? closeAndExit : closeAndSave}
                onDiscard={discard}
                onUnavailableSend={unavailableSend}
              />
              <PasteContentPlugin
                draftId={draft.id}
                onAttachment={addAttachment}
                onError={onToast}
                onPreservedContent={notePreservedContent}
              />
              <InlineQuote draftId={draft.id} html={draft.quoteHtml} />
            </div>
            <footer
              data-testid="composer-footer"
              className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-t border-edge px-4"
            >
              <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                <EditorToolbar />
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
        </DraftContentIdContext.Provider>
      </div>
    </section>
  )
})
