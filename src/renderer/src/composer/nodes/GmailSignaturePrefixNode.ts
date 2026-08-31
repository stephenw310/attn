import {
  $setDirectionFromDOM,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  type SerializedElementNode,
  type Spread
} from 'lexical'
import { isGmailSignaturePrefixClass, sanitizeComposerStyle } from '../sanitize'

type SerializedGmailSignaturePrefixNode = Spread<{ style: string }, SerializedElementNode>

/** Gmail's separator is an editable row in Attn and a marked span when sent back to Gmail. */
export class GmailSignaturePrefixNode extends ElementNode {
  static getType(): string {
    return 'gmail-signature-prefix'
  }

  static clone(node: GmailSignaturePrefixNode): GmailSignaturePrefixNode {
    return new GmailSignaturePrefixNode(node.__key)
  }

  static importJSON(serialized: SerializedGmailSignaturePrefixNode): GmailSignaturePrefixNode {
    return new GmailSignaturePrefixNode()
      .updateFromJSON(serialized)
      .setStyle(sanitizeComposerStyle(serialized.style))
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (element) => {
        if (!isGmailSignaturePrefixClass(element.getAttribute('class'))) return null
        return {
          conversion: (source) => {
            const element = source as HTMLElement
            const authoredStyle = element.getAttribute('style')
            const node = new GmailSignaturePrefixNode().setStyle(sanitizeComposerStyle(authoredStyle))
            $setDirectionFromDOM(node, element)
            // Preserve the delimiter's trailing space while Lexical imports children.
            // Capture the authored style first, then restore it after the temporary hint.
            element.style.whiteSpace = 'pre-wrap'
            return {
              node,
              after: (children) => {
                if (authoredStyle === null) element.removeAttribute('style')
                else element.setAttribute('style', authoredStyle)
                return children
              }
            }
          },
          priority: 3
        }
      }
    }
  }

  private applyAttributes(element: HTMLElement): void {
    element.className = 'gmail_signature_prefix'
    const style = sanitizeComposerStyle(this.getStyle())
    if (style) element.setAttribute('style', style)
    else element.removeAttribute('style')
    const direction = this.getDirection()
    if (direction) element.setAttribute('dir', direction)
    else element.removeAttribute('dir')
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    this.applyAttributes(element)
    element.setAttribute('data-testid', 'composer-gmail-signature-prefix')
    return element
  }

  updateDOM(_previous: GmailSignaturePrefixNode, element: HTMLElement): false {
    this.applyAttributes(element)
    return false
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    this.applyAttributes(element)
    return { element }
  }

  exportJSON(): SerializedGmailSignaturePrefixNode {
    return {
      ...super.exportJSON(),
      type: 'gmail-signature-prefix',
      version: 1,
      style: this.getStyle()
    }
  }

  canBeEmpty(): false {
    return false
  }
}
