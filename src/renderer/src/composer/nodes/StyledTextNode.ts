import {
  $isTextNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type SerializedTextNode,
  type TextFormatType,
  TextNode
} from 'lexical'
import { cssDeclarations } from '../../../../shared/css'
import { sanitizeComposerStyle } from '../sanitize'

function styleConversion(element: HTMLElement): DOMConversionOutput {
  const style = document.createElement('span').style
  const sanitized = sanitizeComposerStyle(element.getAttribute('style') ?? '')
  style.cssText = sanitized
  const formats: TextFormatType[] = []
  if (style.fontWeight === 'bold' || Number.parseInt(style.fontWeight, 10) >= 600) formats.push('bold')
  if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') formats.push('italic')
  if (style.textDecoration.includes('underline')) formats.push('underline')
  if (style.textDecoration.includes('line-through')) formats.push('strikethrough')
  // Native format flags must control emphasis, including later toolbar edits.
  style.removeProperty('font-weight')
  style.removeProperty('font-style')
  style.removeProperty('text-decoration')
  const cleanStyle = cssDeclarations(sanitized)
    .filter(({ property }) => !['font-weight', 'font-style', 'text-decoration'].includes(property))
    .map(({ raw }) => raw)
    .join('; ')
  return {
    forChild: (child) => {
      if (!$isTextNode(child)) return child
      for (const format of formats) {
        if (!child.hasFormat(format)) child.toggleFormat(format)
      }
      return child.setStyle(cleanStyle)
    },
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
      .setStyle(sanitizeComposerStyle(serialized.style))
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: () => ({ conversion: styleConversion, priority: 1 })
    }
  }
}
