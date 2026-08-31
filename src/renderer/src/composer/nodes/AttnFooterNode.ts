import {
  $setDirectionFromDOM,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  type SerializedElementNode
} from 'lexical'

export type SerializedAttnFooterNode = SerializedElementNode

export const ATTN_FOOTER_ATTRIBUTE = 'data-attn-signature'

function isAttnFooter(element: HTMLElement): boolean {
  return element.getAttribute(ATTN_FOOTER_ATTRIBUTE) === 'footer'
}

/**
 * The optional "Sent with Attn" footer (F6/T32B): an ordinary editable block
 * that keeps its marker attribute on export, so the untouched-draft baseline
 * can recognize it across save, reopen, and the Gmail mirror. Unlike the
 * Gmail signature it never collapses — the line stays visible and removable
 * in the composer, and deleting it deletes it for good.
 */
export class AttnFooterNode extends ElementNode {
  static getType(): string {
    return 'attn-footer'
  }

  static clone(node: AttnFooterNode): AttnFooterNode {
    return new AttnFooterNode(node.__key)
  }

  static importJSON(serialized: SerializedAttnFooterNode): AttnFooterNode {
    return new AttnFooterNode().updateFromJSON(serialized)
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (element) => {
        if (!isAttnFooter(element)) return null
        return {
          conversion: (node) => {
            const footer = new AttnFooterNode()
            $setDirectionFromDOM(footer, node as HTMLElement)
            return { node: footer }
          },
          priority: 3
        }
      }
    }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    element.setAttribute(ATTN_FOOTER_ATTRIBUTE, 'footer')
    element.setAttribute('data-testid', 'composer-attn-signature')
    const direction = this.getDirection()
    if (direction) element.setAttribute('dir', direction)
    return element
  }

  updateDOM(previous: AttnFooterNode, element: HTMLElement): boolean {
    const direction = this.getDirection()
    if (direction !== previous.getDirection()) {
      if (direction) element.setAttribute('dir', direction)
      else element.removeAttribute('dir')
    }
    return false
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div')
    element.setAttribute(ATTN_FOOTER_ATTRIBUTE, 'footer')
    const direction = this.getDirection()
    if (direction) element.setAttribute('dir', direction)
    return { element }
  }

  exportJSON(): SerializedAttnFooterNode {
    return {
      ...super.exportJSON(),
      type: 'attn-footer',
      version: 1
    }
  }

  /** Nested rows import as editable paragraphs inside this boundary. */
  isShadowRoot(): boolean {
    return true
  }
}
