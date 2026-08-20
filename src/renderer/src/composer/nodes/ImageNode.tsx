import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical'

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
      serialized.src,
      serialized.contentId,
      serialized.altText,
      serialized.width,
      serialized.height,
      serialized.style,
      serialized.dataSurl ?? ''
    )
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({
        conversion: (element) => {
          const image = element as HTMLImageElement
          const source = image.getAttribute('src') ?? ''
          const contentId =
            image.getAttribute('data-attn-cid') ??
            (source.toLowerCase().startsWith('cid:') ? source.slice(4) : '')
          return {
            node: new ImageNode(
              source,
              contentId,
              image.getAttribute('alt') ?? '',
              image.hasAttribute('width') ? Number(image.getAttribute('width')) || null : null,
              image.hasAttribute('height') ? Number(image.getAttribute('height')) || null : null,
              image.getAttribute('style') ?? '',
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
    // Writing a cid: URL here makes Chromium try to load it and emit a CSP error;
    // serialization swaps this source to cid: after the DOM has become a string.
    image.setAttribute('src', this.__src)
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
      <img
        src={this.__src}
        alt={this.__altText}
        width={this.__width ?? undefined}
        height={this.__height ?? undefined}
        style={this.__style ? undefined : { maxWidth: '100%', height: 'auto' }}
        className="max-w-full rounded-sm"
        referrerPolicy="no-referrer"
        ref={(element) => {
          if (element && this.__style) element.setAttribute('style', this.__style)
        }}
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
