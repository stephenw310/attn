import {
  $createParagraphNode,
  $isDecoratorNode,
  $isElementNode,
  type LexicalNode,
  type ParagraphNode
} from 'lexical'

/** Keep Gmail's `<div><br></div>` separators from disappearing during DOM import. */
export function preserveBlankLineBlocks(document: Document): void {
  for (const block of document.querySelectorAll<HTMLDivElement>('div')) {
    let hasBreak = false
    let blank = true
    for (const child of block.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue
      if (child instanceof HTMLBRElement) {
        hasBreak = true
        continue
      }
      blank = false
      break
    }
    if (!blank || !hasBreak) continue

    const paragraph = document.createElement('p')
    for (const attribute of block.attributes) {
      paragraph.setAttribute(attribute.name, attribute.value)
    }
    while (block.firstChild) paragraph.append(block.firstChild)
    block.replaceWith(paragraph)
  }
}

/**
 * `RootNode` accepts only element and decorator children, but mail HTML puts
 * inline content at the top level all the time — a `<br>` between a signature
 * and a quoted trail is the common one. `$generateNodesFromDOM` maps those to
 * inline nodes, so appending its output to the root verbatim throws
 * `rootNode.splice: Only element or decorator nodes can be inserted to the
 * root node`, which the composer's `onError` rethrows into the React tree.
 *
 * Gather each run of inline nodes into a paragraph — where a browser renders
 * them anyway — so loading a draft body can never take the editor down.
 */
export function rootLevelNodes(nodes: LexicalNode[]): LexicalNode[] {
  const roots: LexicalNode[] = []
  let inlineHost: ParagraphNode | null = null
  for (const node of nodes) {
    if ($isElementNode(node) || $isDecoratorNode(node)) {
      inlineHost = null
      roots.push(node)
      continue
    }
    if (!inlineHost) {
      inlineHost = $createParagraphNode()
      roots.push(inlineHost)
    }
    inlineHost.append(node)
  }
  return roots
}
