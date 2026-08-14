import { $generateHtmlFromNodes } from '@lexical/html'
import type { EditorState, LexicalEditor, SerializedEditorState, SerializedLexicalNode } from 'lexical'
import { sanitizeOutgoingHtml } from './sanitize'

interface SerializedElement extends SerializedLexicalNode {
  children?: SerializedLexicalNode[]
  listType?: 'bullet' | 'number' | 'check'
  start?: number
  text?: string
}

function childrenOf(node: SerializedLexicalNode): SerializedLexicalNode[] {
  return (node as SerializedElement).children ?? []
}

function inlineText(node: SerializedLexicalNode): string {
  const element = node as SerializedElement
  if (node.type === 'text') return element.text ?? ''
  if (node.type === 'linebreak') return '\n'
  return childrenOf(node).map(inlineText).join('')
}

function blockText(node: SerializedLexicalNode): string {
  const element = node as SerializedElement
  if (node.type === 'quote') {
    return inlineText(node)
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n')
  }
  if (node.type === 'list') {
    const ordered = element.listType === 'number'
    const start = element.start ?? 1
    return childrenOf(node)
      .map((item, index) => `${ordered ? `${start + index}.` : '-'} ${inlineText(item)}`.trimEnd())
      .join('\n')
  }
  return inlineText(node)
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
      bodyHtml = sanitizeOutgoingHtml($generateHtmlFromNodes(editor))
    },
    { editor }
  )
  return { bodyHtml, bodyText: editorStateToPlainText(editorState.toJSON()) }
}
