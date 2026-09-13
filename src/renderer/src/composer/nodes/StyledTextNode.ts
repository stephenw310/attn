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
  const represented = new Set<string>()
  if (['normal', '400', 'bold', '700'].includes(style.fontWeight)) {
    represented.add('font-weight')
    if (['bold', '700'].includes(style.fontWeight)) formats.push('bold')
  }
  if (['normal', 'italic'].includes(style.fontStyle)) {
    represented.add('font-style')
    if (style.fontStyle === 'italic') formats.push('italic')
  }
  const decoration = style.textDecoration.trim().split(/\s+/)
  if (decoration.every((value) => ['none', 'underline', 'line-through'].includes(value))) {
    represented.add('text-decoration')
    if (decoration.includes('underline')) formats.push('underline')
    if (decoration.includes('line-through')) formats.push('strikethrough')
  }
  // Keep CSS whenever flags cannot reproduce the complete presentation.
  const cleanStyle = cssDeclarations(sanitized)
    .filter(({ property }) => !represented.has(property))
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
