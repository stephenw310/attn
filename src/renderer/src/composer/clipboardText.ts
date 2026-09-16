import { $generateNodesFromRawText, $isTextNode, type RangeSelection } from 'lexical'

/** Paste plain text using the captured destination style, including across line breaks. */
export function $insertPlainClipboardText(selection: RangeSelection, text: string): void {
  const nodes = $generateNodesFromRawText(text.replace(/\r\n?/g, '\n'))
  for (const node of nodes) {
    if ($isTextNode(node)) node.setFormat(selection.format).setStyle(selection.style)
  }
  selection.insertNodes(nodes)
}
