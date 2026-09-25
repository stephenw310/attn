import DOMPurify from 'dompurify'
import { sanitizeMailHtml } from '../../shared/mailSanitizer'

function searchTextNodes(root: Node): { text: string; nodes: { node: Text; start: number; end: number }[] } {
  const nodes: { node: Text; start: number; end: number }[] = []
  let text = ''
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length
      text += node.textContent ?? ''
      nodes.push({ node: node as Text, start, end: text.length })
      return
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) visit(child)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as HTMLElement
    if (element.matches('script, style, noscript, button, [aria-hidden="true"]')) return
    // The reader may hide an entire body or quote until its match is selected.
    // Sender-hidden content within an HTML frame is not readable content.
    if (root.ownerDocument !== document && element !== root) {
      const style = root.ownerDocument?.defaultView?.getComputedStyle(element)
      if (style?.display === 'none' || style?.visibility === 'hidden') return
    }
    const block = /^(ADDRESS|ARTICLE|BLOCKQUOTE|BR|DIV|H[1-6]|HR|LI|P|PRE|SECTION|TD|TH|TR|UL|OL)$/.test(
      element.tagName
    )
    if (block) text += '\n'
    for (const child of element.childNodes) visit(child)
    if (block) text += '\n'
  }
  visit(root)
  return { text, nodes }
}

/** Keep sender markup inert: only text enters the hidden search representation. */
export function collapsedFindText(html: string | null, plainText: string): string {
  if (!html) return plainText
  const template = document.createElement('template')
  template.innerHTML = sanitizeMailHtml(DOMPurify, html)
  return searchTextNodes(template.content).text
}

/** Find literal, case-insensitive phrases across inline markup without changing mail DOM. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query.trim()) return []
  const { text, nodes } = searchTextNodes(root)
  const pattern = query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  const ranges: Range[] = []
  let firstIndex = 0
  let lastIndex = 0
  for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
    const start = match.index
    const end = start + match[0].length
    while (firstIndex < nodes.length && nodes[firstIndex].end <= start) firstIndex++
    lastIndex = Math.max(firstIndex, lastIndex)
    while (lastIndex < nodes.length && nodes[lastIndex].end < end) lastIndex++
    const first = nodes[firstIndex]
    const last = nodes[lastIndex]
    if (!first || !last) continue
    const range = root.ownerDocument.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    ranges.push(range)
  }
  return ranges
}

export const FIND_HIGHLIGHT_CSS = `
::highlight(attn-find) { background-color: #f5d76e; color: #242016; }
::highlight(attn-find-active) { background-color: #ed8936; color: #1c140c; }
`
