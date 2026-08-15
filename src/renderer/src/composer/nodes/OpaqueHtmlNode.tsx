import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DraftContentIdContext } from '../DraftContentContext'
import { decodeOpaqueHtml, opaqueHtmlText } from '../preserve'

export type SerializedOpaqueHtmlNode = Spread<{ html: string; inline: boolean }, SerializedLexicalNode>

const TRANSPARENT_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const MAX_PREVIEW_HEIGHT = 600

function normalizeContentId(value: string): string {
  try {
    return decodeURIComponent(value).replace(/^<|>$/g, '').toLowerCase()
  } catch {
    return value.replace(/^<|>$/g, '').toLowerCase()
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

function previewSrcDoc(html: string, images: ReadonlyMap<string, string>): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (!source.toLowerCase().startsWith('cid:')) continue
    image.setAttribute('src', images.get(normalizeContentId(source.slice(4))) ?? TRANSPARENT_IMAGE)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#202124}body{font:14px/1.6 Arial,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${document.body.innerHTML}</body></html>`
}

function OpaqueHtmlPreview({ encoded, inline }: { encoded: string; inline: boolean }): React.JSX.Element {
  const draftId = useContext(DraftContentIdContext)
  const html = useMemo(() => decodeOpaqueHtml(encoded), [encoded])
  const contentIds = useMemo(() => opaqueContentIds(html), [html])
  const [images, setImages] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [height, setHeight] = useState<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const srcDoc = useMemo(() => previewSrcDoc(html, images), [html, images])

  useEffect(() => {
    setImages(new Map())
    if (!draftId || !window.attn || contentIds.length === 0) return
    let cancelled = false
    void Promise.all(
      contentIds.map(async (contentId) => {
        const normalizedContentId = normalizeContentId(contentId)
        const result = await window.attn?.draft.getInlineImage(draftId, normalizedContentId)
        return [normalizedContentId, result && 'dataUrl' in result ? result.dataUrl : null] as const
      })
    ).then((entries) => {
      if (cancelled) return
      setImages(new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null)))
    })
    return () => {
      cancelled = true
    }
  }, [contentIds, draftId])

  const observe = useCallback((frame: HTMLIFrameElement) => {
    observerRef.current?.disconnect()
    const document = frame.contentDocument
    if (!document?.body) return
    const measure = (): void => {
      const next = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1)
      setHeight(Math.min(Math.ceil(next), MAX_PREVIEW_HEIGHT))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    observerRef.current = observer
  }, [])

  useEffect(
    () => () => {
      observerRef.current?.disconnect()
    },
    []
  )

  const frame = (
    <iframe
      title="Preserved draft content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={inline ? 'block w-96 max-w-full border-0 bg-white' : 'block w-full border-0 bg-white'}
      srcDoc={srcDoc}
      onLoad={(event) => observe(event.currentTarget)}
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
    return new OpaqueHtmlNode(serialized.html, serialized.inline)
  }

  static importDOM(): DOMConversionMap | null {
    const conversion = (inline: boolean) => (element: HTMLElement) => {
      const html = element.getAttribute('data-attn-opaque')
      if (!html) return null
      return {
        conversion: () => ({ node: new OpaqueHtmlNode(html, inline) }),
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

export function $isOpaqueHtmlNode(node: LexicalNode | null | undefined): node is OpaqueHtmlNode {
  return node instanceof OpaqueHtmlNode
}
