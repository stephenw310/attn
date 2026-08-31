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
import { errorMessage } from '../../../shared/error'
import { escapeHtmlText as escapeHtml } from '../../../shared/html'
import type { ThemeAppearance } from '../../../shared/theme'
import { createCommand, matchComposerKey, registerCommands } from '../commands'
import { Kbd } from '../components/Kbd'
import { formatBytes } from '../formatBytes'
import type { ShowToast } from '../hooks/useToast'
import { normalizeAppleMailLineBackgrounds } from '../mailAppleBackgrounds'
import { forceLightMailCss } from '../mailCss'
import { type MailSurface, mailSurfaceForHtml, normalizeNativeMailDocument } from '../mailSurface'
import { modKeyLabel } from '../platform'
import { useTheme } from '../theme'
import { DraftContentIdContext } from './DraftContentContext'
import { EditorToolbar } from './EditorToolbar'
import { editorConfig } from './editorConfig'
import { COLLAPSED_GMAIL_SIGNATURE_SELECTOR, revealGmailSignature } from './nodes/GmailSignatureNode'
import { $createImageNode, ImageNode } from './nodes/ImageNode'
import { prepareHtmlForEditor } from './preserve'
import { RecipientField, type RecipientFieldHandle } from './RecipientField'
import { preserveBlankLineBlocks, rootLevelNodes } from './rootNodes'
import { sanitizeOutgoingHtml } from './sanitize'
import { useComposerDraft } from './useComposerDraft'

interface ComposerProps {
  draft: Draft
  mode?: 'full' | 'inline'
  attachedToMessage?: boolean
  initialError?: string | null
  onClose: () => void
  onExit?: () => void
  onToast: ShowToast
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

function attachmentErrorMessage(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('Each attachment must be 25 MB or less')) {
    return 'Each attachment must be 25 MB or less'
  }
  if (message.includes('Attachments must total 25 MB or less')) {
    return 'Attachments must total 25 MB or less'
  }
  if (message.includes('Only files can be attached')) return 'Only files can be attached'
  if (message.includes('Attach no more than')) return message
  if (message.startsWith('Attachment is unavailable:')) return message
  if (message.startsWith('Could not copy attachment:')) return message
  if (message.startsWith('Attachments changed')) return message
  return 'Could not attach file'
}

function composerTitle(kind: Draft['kind']): string {
  if (kind === 'reply') return 'Reply'
  if (kind === 'replyAll') return 'Reply all'
  if (kind === 'forward') return 'Forward'
  return 'New message'
}

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const QUOTE_MAX_HEIGHT = 720

/**
 * Module scope on purpose. `LinkPlugin` re-registers its node transform
 * whenever this identity changes, and registering a transform runs it over the
 * whole document inside an `editor.update`. That update reconciles the DOM
 * selection back into the editor, so an inline arrow here pulls the caret out
 * of the recipient fields on every keystroke.
 */
function validateComposerUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url)
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

function quoteSrcDoc(body: string, surface: MailSurface, appearance: ThemeAppearance): string {
  const senderCanvas = surface === 'light'
  const light = senderCanvas || appearance === 'light'
  const nativeContrast = light
    ? ''
    : 'body,body :where(*){color:inherit!important;background-color:transparent!important;background-image:none!important}body a{color:#60a5fa!important}'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${light ? 'light' : 'dark'}"><base target="_blank"><style>:root{color-scheme:${light ? 'light' : 'dark'}}html,body{box-sizing:border-box;margin:0;background:${senderCanvas ? '#fff' : 'transparent'}!important}html{padding:0;overflow-x:auto;overflow-y:auto}body{padding:${senderCanvas ? '12px' : '0'};color:${light ? '#202124' : '#939baa'};font:${light ? '14px/1.6' : '15px/1.7'} Arial,Helvetica,sans-serif;overflow-wrap:break-word}blockquote{margin:.35rem 0 0;border-left:1px solid ${light ? '#dadce0' : '#555d69'};padding-left:1rem}p:first-child{margin-top:0}p:last-child{margin-bottom:0}a{color:${light ? '#1a73e8' : '#d7a13c'}}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}${nativeContrast}</style></head><body>${body}</body></html>`
}

function InlineQuote({
  draftId,
  html,
  expanded: controlledExpanded,
  showToggle = true
}: {
  draftId: string
  html: string
  expanded?: boolean
  showToggle?: boolean
}): React.JSX.Element | null {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = controlledExpanded ?? localExpanded
  const { appearance } = useTheme()
  const surface = useMemo(() => mailSurfaceForHtml(html), [html])
  const [srcDoc, setSrcDoc] = useState(() => quoteSrcDoc('', surface, appearance))
  const [height, setHeight] = useState(1)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)

  const forwardKey = useCallback((event: KeyboardEvent) => {
    const paletteShortcut =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLocaleLowerCase() === 'k'
    if ((event.metaKey || event.ctrlKey || event.altKey) && !paletteShortcut) return
    if (event.key === 'Tab') return
    const target = event.target as HTMLElement | null
    if (event.key === 'Enter' && target?.closest?.('a, button, input, textarea, select')) return
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
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
    // Detect the paste artifact before outgoing sanitization drops its CSS marker.
    // Only the detached display copy changes, and it still passes through the sanitizer.
    const displayCopy = new DOMParser().parseFromString(html, 'text/html')
    normalizeAppleMailLineBackgrounds(displayCopy)
    const document = new DOMParser().parseFromString(
      sanitizeOutgoingHtml(displayCopy.body.innerHTML),
      'text/html'
    )
    if (surface === 'native' && appearance === 'dark') normalizeNativeMailDocument(document.body)
    if (appearance === 'light' || surface === 'light') {
      document.querySelectorAll('style').forEach((style) => {
        style.textContent = forceLightMailCss(style.textContent ?? '')
      })
    }
    const pending = [...document.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
      const source = image.getAttribute('src') ?? ''
      if (!source.toLowerCase().startsWith('cid:') || !window.attn) return []
      const contentId = source.slice(4)
      image.setAttribute('src', TRANSPARENT_IMAGE)
      return [{ contentId, image }]
    })
    setSrcDoc(quoteSrcDoc(document.body.innerHTML, surface, appearance))
    void Promise.all(
      pending.map(async ({ contentId, image }) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        if (result && 'dataUrl' in result) image.setAttribute('src', result.dataUrl)
      })
    ).then(() => {
      if (!cancelled) setSrcDoc(quoteSrcDoc(document.body.innerHTML, surface, appearance))
    })
    return () => {
      cancelled = true
    }
  }, [appearance, draftId, html, surface])

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

  if (!html || (!expanded && !showToggle)) return null
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
          data-appearance={appearance}
          className={`block w-full border-0 ${surface === 'light' ? 'bg-mail-light-ground' : 'bg-transparent'}`}
          srcDoc={srcDoc}
          onLoad={(event) => observe(event.currentTarget)}
          style={{ colorScheme: surface === 'light' ? 'light' : appearance, height }}
        />
      )}
      {showToggle && (
        <button
          type="button"
          className={`${expanded ? 'mt-1' : ''} block cursor-pointer border-0 bg-transparent px-0.5 text-sm font-normal tracking-normal text-ink-faint hover:text-ink`}
          data-testid="composer-quote-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide quoted history' : 'Show quoted history'}
          title={expanded ? 'Hide quoted history' : 'Show quoted history'}
          onClick={() => setLocalExpanded((current) => !current)}
        >
          ...
        </button>
      )}
    </div>
  )
}

function InitialHtmlPlugin({ draftId, html }: { draftId: string; html: string }): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    if (!html) return
    let cancelled = false
    const document = new DOMParser().parseFromString(html, 'text/html')
    preserveBlankLineBlocks(document)
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
        const nodes = rootLevelNodes($generateNodesFromDOM(editor, document))
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

function CollapsedSignaturePlugin({
  includesQuote,
  onReveal
}: {
  includesQuote: boolean
  onReveal: () => void
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const label = includesQuote ? 'Show signature and quoted history' : 'Show signature'
    const updateLabels = (): void => {
      for (const signature of editor
        .getRootElement()
        ?.querySelectorAll<HTMLElement>(COLLAPSED_GMAIL_SIGNATURE_SELECTOR) ?? []) {
        signature.setAttribute('aria-label', label)
        signature.setAttribute('title', label)
      }
    }
    const collapsedSignature = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(COLLAPSED_GMAIL_SIGNATURE_SELECTOR) : null
    const revealFromClick = (event: MouseEvent): void => {
      const signature = collapsedSignature(event.target)
      if (!signature) return
      event.preventDefault()
      event.stopPropagation()
      revealGmailSignature(signature)
      onReveal()
    }
    const revealFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const signature = collapsedSignature(event.target)
      if (!signature) return
      event.preventDefault()
      event.stopPropagation()
      revealGmailSignature(signature)
      onReveal()
    }

    const unregisterRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('click', revealFromClick, true)
      previous?.removeEventListener('keydown', revealFromKeyboard, true)
      root?.addEventListener('click', revealFromClick, true)
      root?.addEventListener('keydown', revealFromKeyboard, true)
      updateLabels()
    })
    const unregisterUpdate = editor.registerUpdateListener(updateLabels)
    updateLabels()
    return () => {
      unregisterUpdate()
      unregisterRoot()
    }
  }, [editor, includesQuote, onReveal])
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
  useEffect(() => {
    // One handler per effect run: Lexical calls the root listener with
    // `(null, previousRoot)` on unregister, so the function removed there must
    // be the one that was added, or every re-run leaves a paste handler behind.
    const onPaste = (event: ClipboardEvent): void => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
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
        preserveBlankLineBlocks(document)
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
    return editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('paste', onPaste, true)
      root?.addEventListener('paste', onPaste, true)
    })
  }, [draftId, editor, onAttachment, onError, onPreservedContent])
  return null
}

interface CommandPluginProps {
  onAttach: () => void
  onRemoveAttachment: () => void
  onClose: () => void
  onDiscard: () => void
  onSend: () => void
}

function ComposerCommandPlugin({
  onAttach,
  onRemoveAttachment,
  onClose,
  onDiscard,
  onSend
}: CommandPluginProps): null {
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
        createCommand('composer.removeAttachment', onRemoveAttachment),
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
    [editor, onAttach, onRemoveAttachment, onClose, onDiscard, onSend, quote]
  )
  return null
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { draft, mode = 'full', attachedToMessage = false, initialError = null, onClose, onExit, onToast },
  ref
): React.JSX.Element {
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
  const unifiedSignatureAndQuote = useMemo(
    () => Boolean(draft.quoteHtml) && hasGmailSignature(preparedHtml.html),
    [draft.quoteHtml, preparedHtml.html]
  )
  const [unifiedContentExpanded, setUnifiedContentExpanded] = useState(false)
  const revealUnifiedContent = useCallback(() => setUnifiedContentExpanded(true), [])
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
    (request: () => Promise<{ attachments: Draft['attachments']; changed: boolean }>) => {
      if (closing) return
      if (attachmentMutationRef.current) {
        onToast('Wait for the current attachment change to finish')
        return
      }
      attachmentMutationRef.current = true
      setAttaching(true)
      void request()
        .then((result) => {
          if (result.changed) replaceAttachments(result.attachments)
        })
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
      if (!window.attn || closing) return
      if (attachmentMutationRef.current) {
        onToast('Wait for the current attachment change to finish')
        return
      }
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

  // Attaching is keyboard-reachable, so removing has to be too. Inline body
  // images have no chip and are removed by editing the body instead.
  const removeLastAttachment = useCallback(() => {
    const last = visibleAttachments.at(-1)
    if (!last) {
      onToast('No attachments to remove')
      return
    }
    removeAttachment(last.id)
  }, [onToast, removeAttachment, visibleAttachments])

  const saveAndClose = useCallback(
    (afterClose: () => void) => {
      if (closing || !window.attn) return
      if (attachmentMutationRef.current) {
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
    [closing, commitPendingRecipients, draft.id, onToast, saveNow]
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
  }, [closing, commitPendingRecipients, draft.id, onClose, onToast, saveNow])

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
    if (attachmentMutationRef.current) {
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
  }, [closing, draft.id, onClose, onToast])

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
                  <div className="pointer-events-none absolute left-5 top-5 text-[13px] leading-5 text-ink-faint">
                    Write a message…
                  </div>
                }
                ErrorBoundary={LexicalErrorBoundary}
              />
              <HistoryPlugin />
              <ListPlugin />
              <TablePlugin />
              <LinkPlugin validateUrl={validateComposerUrl} />
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
              />
              <PasteContentPlugin
                draftId={draft.id}
                onAttachment={addAttachment}
                onError={onToast}
                onPreservedContent={notePreservedContent}
              />
              <InlineQuote
                draftId={draft.id}
                html={draft.quoteHtml}
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
        </DraftContentIdContext.Provider>
      </div>
    </section>
  )
})
