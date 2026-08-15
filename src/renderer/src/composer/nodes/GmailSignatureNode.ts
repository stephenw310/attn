import {
  $applyNodeReplacement,
  $setDirectionFromDOM,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type SerializedElementNode
} from 'lexical'

export type SerializedGmailSignatureNode = SerializedElementNode

function isGmailSignature(element: HTMLElement): boolean {
  return (
    element.classList.contains('gmail_signature') ||
    element.getAttribute('data-smartmail') === 'gmail_signature'
  )
}

/** An editable block boundary that retains Gmail's signature marker on export. */
export class GmailSignatureNode extends ElementNode {
  static getType(): string {
    return 'gmail-signature'
  }

  static clone(node: GmailSignatureNode): GmailSignatureNode {
    return new GmailSignatureNode(node.__key)
  }

  static importJSON(serialized: SerializedGmailSignatureNode): GmailSignatureNode {
    return new GmailSignatureNode().updateFromJSON(serialized)
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (element) => {
        if (!isGmailSignature(element)) return null
        return {
          conversion: (node) => {
            const signature = new GmailSignatureNode()
            $setDirectionFromDOM(signature, node as HTMLElement)
            return { node: signature }
          },
          priority: 3
        }
      }
    }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    element.className = 'gmail_signature'
    element.setAttribute('data-smartmail', 'gmail_signature')
    element.setAttribute('data-testid', 'composer-gmail-signature')
    const direction = this.getDirection()
    if (direction) element.setAttribute('dir', direction)
    return element
  }

  updateDOM(previous: GmailSignatureNode, element: HTMLElement): boolean {
    const direction = this.getDirection()
    if (direction !== previous.getDirection()) {
      if (direction) element.setAttribute('dir', direction)
      else element.removeAttribute('dir')
    }
    return false
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div')
    element.className = 'gmail_signature'
    element.setAttribute('data-smartmail', 'gmail_signature')
    const direction = this.getDirection()
    if (direction) element.setAttribute('dir', direction)
    return { element }
  }

  exportJSON(): SerializedGmailSignatureNode {
    return {
      ...super.exportJSON(),
      type: 'gmail-signature',
      version: 1
    }
  }

  /** Nested Gmail divs import as editable paragraphs inside this boundary. */
  isShadowRoot(): boolean {
    return true
  }
}

export function $createGmailSignatureNode(): GmailSignatureNode {
  return $applyNodeReplacement(new GmailSignatureNode())
}

export function $isGmailSignatureNode(node: LexicalNode | null | undefined): node is GmailSignatureNode {
  return node instanceof GmailSignatureNode
}
