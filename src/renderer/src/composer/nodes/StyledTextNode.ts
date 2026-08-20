import {
  $isTextNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type SerializedTextNode,
  TextNode
} from 'lexical'
import { sanitizeComposerStyle } from '../sanitize'

function styleConversion(element: HTMLElement): DOMConversionOutput {
  const cleanStyle = sanitizeComposerStyle(element.getAttribute('style') ?? '')
  return {
    forChild: (child) => (cleanStyle && $isTextNode(child) ? child.setStyle(cleanStyle) : child),
    node: null
  }
}

export class StyledTextNode extends TextNode {
  static getType(): string {
    return 'styled-text'
  }

  static clone(node: StyledTextNode): StyledTextNode {
    return new StyledTextNode(node.__text, node.__key)
  }

  static importJSON(serialized: SerializedTextNode): StyledTextNode {
    return new StyledTextNode(serialized.text)
      .setFormat(serialized.format)
      .setDetail(serialized.detail)
      .setMode(serialized.mode)
      .setStyle(serialized.style)
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: () => ({ conversion: styleConversion, priority: 1 })
    }
  }
}
