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
import { decodeOpaqueHtml, opaqueHtmlText } from '../preserve'

export type SerializedOpaqueHtmlNode = Spread<{ html: string; inline: boolean }, SerializedLexicalNode>

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
    const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{margin:0;color:#202124;font:14px/1.6 Arial,sans-serif}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${decodeOpaqueHtml(this.__html)}</body></html>`
    if (this.__inline) {
      return (
        <span
          className="mx-1 inline-flex max-w-full flex-col rounded border border-dashed border-edge bg-white p-2 align-middle"
          contentEditable={false}
        >
          <span className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">
            Preserved content
          </span>
          <iframe
            title="Preserved draft content"
            sandbox=""
            className="h-20 w-64 max-w-full border-0"
            srcDoc={srcDoc}
          />
        </span>
      )
    }
    return (
      <div className="my-2 rounded border border-dashed border-edge bg-white p-2" contentEditable={false}>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">
          Preserved content
        </div>
        <iframe title="Preserved draft content" sandbox="" className="h-40 w-full border-0" srcDoc={srcDoc} />
      </div>
    )
  }
}

export function $isOpaqueHtmlNode(node: LexicalNode | null | undefined): node is OpaqueHtmlNode {
  return node instanceof OpaqueHtmlNode
}
