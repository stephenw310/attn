import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { MailFrame, mailFrameShell, useMailFrameAccess } from '../../mailFrame'
import { normalizedContentId, TRANSPARENT_IMAGE } from '../../mailInlineImages'
import { suppressBlockedRemoteImages } from '../../mailRemoteContent'
import { DraftContentIdContext, DraftSourceMessageIdContext } from '../DraftContentContext'
import { decodeOpaqueHtml, encodeOpaqueHtml, opaqueHtmlText, sanitizedDomMatchesSource } from '../preserve'
import { sanitizeDraftHtmlForImport } from '../sanitize'

export type SerializedOpaqueHtmlNode = Spread<{ html: string; inline: boolean }, SerializedLexicalNode>

const MAX_PREVIEW_HEIGHT = 600

function sanitizeEncodedHtml(encoded: unknown): string {
  if (typeof encoded !== 'string') return ''
  try {
    const source = decodeOpaqueHtml(encoded)
    const sanitized = sanitizeDraftHtmlForImport(source)
    return sanitizedDomMatchesSource(source, sanitized) ? encoded : encodeOpaqueHtml(sanitized)
  } catch {
    return ''
  }
}

function opaqueContentIds(html: string): string[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [
    ...new Set(
      [...document.querySelectorAll<HTMLImageElement>('img[src]')]
        .map((image) => image.getAttribute('src')?.trim() ?? '')
        .filter((source) => source.toLowerCase().startsWith('cid:'))
        .map((source) => source.slice(4))
    )
  ]
}

/**
 * The preserved region is already node-level sanitized; this pass only swaps in
 * the images the preview may paint, then hands the body to the one mail-frame
 * shell every untrusted `about:srcdoc` document shares (review R5).
 */
function previewSrcDoc(
  html: string,
  images: ReadonlyMap<string, string>,
  remoteImagesAllowed: boolean
): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  if (!remoteImagesAllowed) suppressBlockedRemoteImages(document.body, TRANSPARENT_IMAGE)
  for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (!source.toLowerCase().startsWith('cid:')) continue
    image.setAttribute('src', images.get(normalizedContentId(source.slice(4))) ?? TRANSPARENT_IMAGE)
  }
  // A draft's preserved markup is authored content on the sender's own light
  // canvas, whatever theme the app is wearing.
  return mailFrameShell(document.body.innerHTML, {
    surface: 'light',
    layout: 'padded',
    appearance: 'light',
    scrollable: true
  })
}

function OpaqueHtmlPreview({ encoded, inline }: { encoded: string; inline: boolean }): React.JSX.Element {
  const draftId = useContext(DraftContentIdContext)
  const sourceMessageId = useContext(DraftSourceMessageIdContext)
  const html = useMemo(() => decodeOpaqueHtml(encoded), [encoded])
  const contentIds = useMemo(() => opaqueContentIds(html), [html])
  const [images, setImages] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [height, setHeight] = useState<number | null>(null)

  // T33: the preserved region is the same untrusted about:srcdoc mail HTML as
  // the quoted history, so it registers with main's request filter under the
  // draft's source message — a per-sender exception then covers a reply's
  // preserved content too (PR #101 review). Without a source id the frame
  // stays unnamed and fails closed while blocking is on.
  const { access } = useMailFrameAccess({ messageId: sourceMessageId })
  const srcDoc = useMemo(
    () => previewSrcDoc(html, images, access?.imagesAllowed === true),
    [access?.imagesAllowed, html, images]
  )

  useEffect(() => {
    setImages(new Map())
    if (!draftId || !window.attn || contentIds.length === 0) return
    let cancelled = false
    void Promise.all(
      contentIds.map(async (contentId) => {
        const normalized = normalizedContentId(contentId)
        const result = await window.attn?.draft.getInlineImage(draftId, normalized)
        return [normalized, result && 'dataUrl' in result ? result.dataUrl : null] as const
      })
    ).then((entries) => {
      if (cancelled) return
      setImages(new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null)))
    })
    return () => {
      cancelled = true
    }
  }, [contentIds, draftId])

  const measure = useCallback((frameDocument: Document) => {
    const next = Math.max(frameDocument.documentElement.scrollHeight, frameDocument.body.scrollHeight, 1)
    setHeight(Math.min(Math.ceil(next), MAX_PREVIEW_HEIGHT))
  }, [])

  // The frame mounts only after main has answered its registration, so an
  // allowed sender's images are never spuriously cancelled by a race; a
  // policy change remounts it (new key) under a fresh registration.
  const frame =
    access === null ? null : (
      <MailFrame
        access={access}
        title="Preserved draft content"
        referrerPolicy="no-referrer"
        className={inline ? 'block w-96 max-w-full border-0 bg-white' : 'block w-full border-0 bg-white'}
        srcDoc={srcDoc}
        onMeasure={measure}
        style={{ height: height ?? 1, visibility: height === null ? 'hidden' : 'visible' }}
      />
    )

  return inline ? (
    <span className="mx-1 inline-flex max-w-full align-middle" contentEditable={false}>
      {frame}
    </span>
  ) : (
    <div className="my-2 max-w-full overflow-auto bg-white" contentEditable={false}>
      {frame}
    </div>
  )
}

export class OpaqueHtmlNode extends DecoratorNode<React.JSX.Element> {
  __html: string
  __inline: boolean

  static getType(): string {
    return 'opaque-html'
  }

  static clone(node: OpaqueHtmlNode): OpaqueHtmlNode {
    return new OpaqueHtmlNode(node.__html, node.__inline, node.__key)
  }

  static importJSON(serialized: SerializedOpaqueHtmlNode): OpaqueHtmlNode {
    return new OpaqueHtmlNode(sanitizeEncodedHtml(serialized.html), serialized.inline === true)
  }

  static importDOM(): DOMConversionMap | null {
    const conversion = (inline: boolean) => (element: HTMLElement) => {
      const html = element.getAttribute('data-attn-opaque')
      if (!html) return null
      return {
        conversion: () => ({ node: new OpaqueHtmlNode(sanitizeEncodedHtml(html), inline) }),
        priority: 4 as const
      }
    }
    return {
      div: conversion(false),
      span: conversion(true)
    }
  }

  constructor(html: string, inline = false, key?: NodeKey) {
    super(key)
    this.__html = html
    this.__inline = inline
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement(this.__inline ? 'span' : 'div')
    element.className = 'app-composer-opaque-node'
    return element
  }

  updateDOM(): false {
    return false
  }

  exportDOM(): DOMExportOutput {
    const marker = document.createElement(this.__inline ? 'span' : 'div')
    marker.setAttribute('data-attn-opaque', this.__html)
    return { element: marker }
  }

  exportJSON(): SerializedOpaqueHtmlNode {
    return {
      ...super.exportJSON(),
      type: 'opaque-html',
      version: 1,
      html: this.__html,
      inline: this.__inline
    }
  }

  getTextContent(): string {
    return opaqueHtmlText(this.__html)
  }

  isInline(): boolean {
    return this.__inline
  }

  decorate(_editor: unknown, _config: EditorConfig): React.JSX.Element {
    return <OpaqueHtmlPreview encoded={this.__html} inline={this.__inline} />
  }
}
