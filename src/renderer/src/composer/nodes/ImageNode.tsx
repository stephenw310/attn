import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'
import { useContext } from 'react'
import { useMailFrameAccess } from '../../mailFrame'
import { TRANSPARENT_IMAGE } from '../../mailInlineImages'
import { isRemoteMailUrl } from '../../mailRemoteContent'
import { DraftSourceMessageIdContext } from '../DraftContentContext'
import { sanitizeComposerImageSource, sanitizeComposerStyle } from '../sanitize'

/**
 * T33 (PR #101 review): the editor renders in the TOP frame, which main's
 * mail-frame request filter deliberately exempts — so an imported draft's
 * remote image would fire an unfiltered tracking request even with blocking
 * on. The decision therefore happens here, before any src is set: a remote
 * source renders only once policy allows it — through the draft's source
 * message (so a per-sender exception covers a reply's imported images,
 * exactly like the quoted history) or, with no source message, through the
 * global toggle alone. While blocked or still resolving, a same-size
 * placeholder holds the layout and the draft's own content is untouched:
 * save, mirror, and send keep the original source.
 */
function ComposerImage({
  src,
  altText,
  width,
  height,
  style
}: {
  src: string
  altText: string
  width: number | null
  height: number | null
  style: string
}): React.JSX.Element {
  const sourceMessageId = useContext(DraftSourceMessageIdContext)
  const remote = isRemoteMailUrl(src)
  // The same registration the quote and preserved-region frames make, for the
  // answer alone: there is no frame here to name, so nothing is mounted on it.
  const { access } = useMailFrameAccess({ messageId: sourceMessageId, enabled: remote })
  const allowed = !remote || access?.imagesAllowed === true

  return (
    <img
      src={allowed ? src : TRANSPARENT_IMAGE}
      data-remote-blocked={remote && !allowed ? 'true' : undefined}
      alt={altText}
      title={remote && !allowed ? 'Remote image blocked' : undefined}
      width={width ?? undefined}
      height={height ?? undefined}
      style={style ? undefined : { maxWidth: '100%', height: 'auto' }}
      className="max-w-full rounded-sm"
      referrerPolicy="no-referrer"
      ref={(element) => {
        if (element && style) element.setAttribute('style', style)
      }}
    />
  )
}

export type SerializedImageNode = Spread<
  {
    altText: string
    contentId: string
    height: number | null
    src: string
    style: string
    dataSurl: string
    width: number | null
  },
  SerializedLexicalNode
>

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export class ImageNode extends DecoratorNode<React.JSX.Element> {
  __src: string
  __contentId: string
  __altText: string
  __width: number | null
  __height: number | null
  __style: string
  __dataSurl: string

  static getType(): string {
    return 'composer-image'
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__contentId,
      node.__altText,
      node.__width,
      node.__height,
      node.__style,
      node.__dataSurl,
      node.__key
    )
  }

  static importJSON(serialized: SerializedImageNode): ImageNode {
    return new ImageNode(
      sanitizeComposerImageSource(serialized.src),
      safeString(serialized.contentId),
      safeString(serialized.altText),
      safeDimension(serialized.width),
      safeDimension(serialized.height),
      sanitizeComposerStyle(serialized.style),
      safeString(serialized.dataSurl)
    )
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({
        conversion: (element) => {
          const image = element as HTMLImageElement
          // A copied export carries its remote source in the data attribute
          // (the visible src is the placeholder); prefer it on re-import.
          const source = image.getAttribute('data-attn-remote-src') ?? image.getAttribute('src') ?? ''
          const contentId =
            image.getAttribute('data-attn-cid') ??
            (source.toLowerCase().startsWith('cid:') ? source.slice(4) : '')
          return {
            node: new ImageNode(
              sanitizeComposerImageSource(source),
              contentId,
              image.getAttribute('alt') ?? '',
              image.hasAttribute('width') ? Number(image.getAttribute('width')) || null : null,
              image.hasAttribute('height') ? Number(image.getAttribute('height')) || null : null,
              sanitizeComposerStyle(image.getAttribute('style') ?? ''),
              image.getAttribute('data-surl') ?? ''
            )
          }
        },
        priority: 2
      })
    }
  }

  constructor(
    src: string,
    contentId: string,
    altText = '',
    width: number | null = null,
    height: number | null = null,
    style = '',
    dataSurl = '',
    key?: NodeKey
  ) {
    super(key)
    this.__src = src
    this.__contentId = contentId
    this.__altText = altText
    this.__width = width
    this.__height = height
    this.__style = style
    this.__dataSurl = dataSurl
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span')
    span.className = 'app-composer-image-node'
    return span
  }

  updateDOM(): false {
    return false
  }

  exportDOM(): DOMExportOutput {
    const image = document.createElement('img')
    // Keep the renderable source while Lexical builds its temporary export DOM.
    // Writing a cid: URL here makes Chromium try to load it and emit a CSP
    // error, and a REMOTE URL on this live-document element would fire a real
    // request on every serialization, before any policy ran (PR #101 review).
    // Both ride data attributes and swap in after the DOM became a string.
    const remote = isRemoteMailUrl(this.__src)
    image.setAttribute('src', remote ? TRANSPARENT_IMAGE : this.__src)
    if (remote) image.setAttribute('data-attn-remote-src', this.__src)
    if (this.__contentId) image.setAttribute('data-attn-cid', this.__contentId)
    if (this.__altText) image.setAttribute('alt', this.__altText)
    if (this.__width) image.setAttribute('width', String(this.__width))
    if (this.__height) image.setAttribute('height', String(this.__height))
    if (this.__style) image.setAttribute('style', this.__style)
    if (this.__dataSurl) image.setAttribute('data-surl', this.__dataSurl)
    return { element: image }
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: 'composer-image',
      version: 1,
      src: this.__src,
      contentId: this.__contentId,
      altText: this.__altText,
      width: this.__width,
      height: this.__height,
      style: this.__style,
      dataSurl: this.__dataSurl
    }
  }

  getTextContent(): string {
    return this.__altText ? `[Image: ${this.__altText}]` : '[Image]'
  }

  getContentId(): string {
    return this.getLatest().__contentId
  }

  setSrc(src: string): void {
    this.getWritable().__src = src
  }

  isInline(): boolean {
    return true
  }

  decorate(_editor: unknown, _config: EditorConfig): React.JSX.Element {
    return (
      <ComposerImage
        src={this.__src}
        altText={this.__altText}
        width={this.__width}
        height={this.__height}
        style={this.__style}
      />
    )
  }
}

export function $createImageNode(
  src: string,
  contentId: string,
  altText = '',
  width: number | null = null,
  height: number | null = null,
  style = ''
): ImageNode {
  return new ImageNode(src, contentId, altText, width, height, style)
}
