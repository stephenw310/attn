import { $getRoot, type LexicalNode } from 'lexical'
import { AttnFooterNode } from './AttnFooterNode'
import { GmailSignatureNode } from './GmailSignatureNode'
import { GmailSignaturePrefixNode } from './GmailSignaturePrefixNode'

/**
 * The nodes below the authored region: the imported Gmail signature, its
 * marked separator, and Attn's optional footer. Undo, select-all, the empty
 * body hint, AI drafting and autocomplete all need the same boundary, and each
 * of them used to spell out its own `instanceof` chain (review R6) — a fifth
 * protected node would have had to be remembered in four places.
 */
export function $isProtectedComposerNode(node: LexicalNode): boolean {
  return (
    node instanceof GmailSignaturePrefixNode ||
    node instanceof GmailSignatureNode ||
    node instanceof AttnFooterNode
  )
}

/** The root-level ancestor a node belongs to, or the node itself. */
export function $topLevelComposerNode(node: LexicalNode): LexicalNode {
  const root = $getRoot()
  let current = node
  let parent = current.getParent()
  while (parent && parent !== root) {
    current = parent
    parent = current.getParent()
  }
  return current
}

/** How many root-level children the user authors, above the protected trail. */
export function $authoredChildCount(): number {
  let authored = 0
  for (const child of $getRoot().getChildren()) {
    if ($isProtectedComposerNode(child)) break
    authored++
  }
  return authored
}
