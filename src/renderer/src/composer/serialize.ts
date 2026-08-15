import { $generateHtmlFromNodes } from '@lexical/html'
import type { EditorState, LexicalEditor, SerializedEditorState, SerializedLexicalNode } from 'lexical'
import { opaqueHtmlText, restoreOpaqueHtml } from './preserve'
import { sanitizeOutgoingHtml } from './sanitize'

interface SerializedElement extends SerializedLexicalNode {
  children?: SerializedLexicalNode[]
  listType?: 'bullet' | 'number' | 'check'
  start?: number
  text?: string
  altText?: string
  html?: string
}

function childrenOf(node: SerializedLexicalNode): SerializedLexicalNode[] {
  return (node as SerializedElement).children ?? []
}

function inlineText(node: SerializedLexicalNode): string {
  const element = node as SerializedElement
  if (node.type === 'text' || node.type === 'styled-text') return element.text ?? ''
  if (node.type === 'linebreak') return '\n'
  if (node.type === 'composer-image') return element.altText ? `[Image: ${element.altText}]` : '[Image]'
  if (node.type === 'opaque-html') return element.html ? opaqueHtmlText(element.html) : ''
  return childrenOf(node).map(inlineText).join('')
}

function listText(node: SerializedLexicalNode, depth = 0): string {
  const element = node as SerializedElement
  const ordered = element.listType === 'number'
  const start = element.start ?? 1
  const lines: string[] = []
  for (const [index, item] of childrenOf(node).entries()) {
    const children = childrenOf(item)
    const content = children
      .filter((child) => child.type !== 'list')
      .map(inlineText)
      .join('')
    if (content || !children.some((child) => child.type === 'list')) {
      const marker = ordered ? `${start + index}.` : '-'
      lines.push(`${'  '.repeat(depth)}${marker} ${content}`.trimEnd())
    }
    for (const nested of children.filter((child) => child.type === 'list')) {
      lines.push(listText(nested, depth + 1))
    }
  }
  return lines.join('\n')
}

function blockText(node: SerializedLexicalNode): string {
  if (node.type === 'gmail-signature') {
    return childrenOf(node).map(blockText).join('\n')
  }
  if (node.type === 'quote') {
    return inlineText(node)
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n')
  }
  if (node.type === 'list') {
    return listText(node)
  }
  return inlineText(node)
}

function inlineImageSourcesToCid(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (image) => {
    const contentId = /\sdata-attn-cid="([^"]+)"/i.exec(image)?.[1]
    if (!contentId) return image
    return image.replace(/\ssrc="[^"]*"/i, ` src="cid:${contentId}"`)
  })
}

export function editorStateToPlainText(state: SerializedEditorState): string {
  return childrenOf(state.root)
    .map(blockText)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function serializeEditorState(
  editorState: EditorState,
  editor: LexicalEditor
): { bodyHtml: string; bodyText: string } {
  let bodyHtml = ''
  editorState.read(
    () => {
      bodyHtml = restoreOpaqueHtml(
        inlineImageSourcesToCid(sanitizeOutgoingHtml($generateHtmlFromNodes(editor)))
      )
    },
    { editor }
  )
  return { bodyHtml, bodyText: editorStateToPlainText(editorState.toJSON()) }
}
