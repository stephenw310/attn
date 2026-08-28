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
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll<HTMLImageElement>('img[data-attn-cid]')) {
    const contentId = image.getAttribute('data-attn-cid')
    image.removeAttribute('data-attn-cid')
    if (contentId) image.setAttribute('src', `cid:${contentId}`)
  }
  return template.innerHTML
}

/** Gmail composes logical rows as divs; paragraphs acquire large margins when it opens a draft. */
function paragraphsToGmailRows(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const paragraph of template.content.querySelectorAll<HTMLParagraphElement>('p')) {
    const row = document.createElement('div')
    for (const attribute of paragraph.attributes) {
      row.setAttribute(attribute.name, attribute.value)
    }
    while (paragraph.firstChild) row.append(paragraph.firstChild)
    paragraph.replaceWith(row)
  }
  return template.innerHTML
}

/** Match the wrapper Gmail emits around a signature so recipient clients can classify it. */
function wrapGmailSignatures(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const signature of template.content.querySelectorAll<HTMLElement>(
    '.gmail_signature, [data-smartmail="gmail_signature"]'
  )) {
    if (!signature.hasAttribute('dir')) {
      const direction = signature.querySelector<HTMLElement>('[dir]')?.getAttribute('dir')
      signature.setAttribute('dir', direction === 'rtl' ? 'rtl' : 'ltr')
    }
    const parent = signature.parentElement
    const dedicatedWrapper =
      parent?.tagName === 'DIV' &&
      [...parent.childNodes].every(
        (child) => child === signature || (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim())
      )
    if (dedicatedWrapper) continue

    const wrapper = document.createElement('div')
    signature.replaceWith(wrapper)
    wrapper.append(signature)
  }
  return template.innerHTML
}

function wrapGmailBody(html: string): string {
  const root = document.createElement('div')
  root.setAttribute('dir', 'ltr')
  root.innerHTML = html
  return root.outerHTML
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
  const serializedState = editorState.toJSON()
  const rootChildren = childrenOf(serializedState.root)
  const preserveExactOpaqueBody = rootChildren.length === 1 && rootChildren[0]?.type === 'opaque-html'
  let bodyHtml = ''
  editorState.read(
    () => {
      const normalizedHtml = wrapGmailSignatures(
        paragraphsToGmailRows(sanitizeOutgoingHtml($generateHtmlFromNodes(editor)))
      )
      bodyHtml = restoreOpaqueHtml(
        inlineImageSourcesToCid(preserveExactOpaqueBody ? normalizedHtml : wrapGmailBody(normalizedHtml))
      )
    },
    { editor }
  )
  return { bodyHtml, bodyText: editorStateToPlainText(serializedState) }
}
