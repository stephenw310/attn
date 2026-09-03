// Autocomplete context extraction (T37A, F17): the bounded authored-body
// excerpt around the caret, and nothing else. Protected regions — quotes,
// tables, the Gmail signature, its prefix, the Attn footer, and opaque
// preserved content — are excluded from extraction itself, not just from
// display, and a caret inside one produces no request at all. Truncation
// keeps the text nearest the caret: the prefix's tail, the suffix's head.

import { $isLinkNode } from '@lexical/link'
import { $isQuoteNode } from '@lexical/rich-text'
import { $isTableNode } from '@lexical/table'
import {
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode
} from 'lexical'
import { AUTOCOMPLETE_MAX_PREFIX_CHARS, AUTOCOMPLETE_MAX_SUFFIX_CHARS } from '../../../shared/ai'
import type { AutocompleteExcerpt } from './autocompleteController'
import { OpaqueHtmlNode } from './nodes/OpaqueHtmlNode'
import { $isProtectedComposerNode } from './nodes/protected'

/**
 * The composer's protected trail, widened for extraction: a quote block, a
 * table and an opaque preserved region are all content the user did not type
 * here, so the caret inside one produces no autocomplete request.
 */
function isProtected(node: LexicalNode): boolean {
  return (
    $isQuoteNode(node) ||
    $isTableNode(node) ||
    node instanceof OpaqueHtmlNode ||
    $isProtectedComposerNode(node)
  )
}

/** Text of one authored top-level node; empty for protected/ambiguous ones. */
function authoredText(node: LexicalNode): string | null {
  if (isProtected(node) || $isDecoratorNode(node)) return null
  return node.getTextContent()
}

/**
 * The caret's identity: node key, offset, and type. Any movement or edit
 * produces a different token, which is what invalidates in-flight requests.
 */
export function $caretAnchor(): string | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const anchor = selection.anchor
  return `${anchor.type}:${anchor.getNode().getKey()}:${anchor.offset}`
}

/**
 * Build the bounded excerpt around a collapsed caret in ordinary editable
 * text, or null when the caret is unusable: a selection, inside a protected
 * region, in a link (ambiguous imported content), or not anchored in text
 * the user authors.
 */
export function $autocompleteExcerpt(): AutocompleteExcerpt | null {
  const anchorToken = $caretAnchor()
  if (anchorToken === null) return null
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  const anchor = selection.anchor
  const anchorNode = anchor.getNode()

  // The caret must sit in ordinary authored text: a text node, or an empty
  // element position, with no protected ancestor anywhere above it.
  let topLevel: LexicalNode | null = null
  for (let node: LexicalNode | null = anchorNode; node !== null; node = node.getParent()) {
    if (isProtected(node) || $isLinkNode(node)) return null
    const parent = node.getParent()
    if (parent !== null && parent.getKey() === 'root') topLevel = node
  }
  if (topLevel === null) return null

  // Caret offset within its top-level node's text.
  let inNodeOffset = 0
  if ($isTextNode(anchorNode)) {
    if ($isElementNode(topLevel)) {
      for (const text of topLevel.getAllTextNodes()) {
        if (text.getKey() === anchorNode.getKey()) break
        inNodeOffset += text.getTextContentSize()
      }
    }
    inNodeOffset += anchor.offset
  } else if ($isElementNode(anchorNode)) {
    // An element anchor (empty paragraph, or between children): everything
    // before the child index counts as prefix.
    const children = anchorNode.getChildren().slice(0, anchor.offset)
    inNodeOffset = children.reduce((total, child) => total + child.getTextContentSize(), 0)
    if (anchorNode.getKey() !== topLevel.getKey() && $isElementNode(topLevel)) {
      let before = 0
      for (const text of topLevel.getAllTextNodes()) {
        if (anchorNode.isParentOf(text) || text.getKey() === anchorNode.getKey()) break
        before += text.getTextContentSize()
      }
      inNodeOffset += before
    }
  } else {
    return null
  }

  const beforeParts: string[] = []
  const afterParts: string[] = []
  let caretNodeText = ''
  let seenCaret = false
  for (const node of $getRoot().getChildren()) {
    if (node.getKey() === topLevel.getKey()) {
      seenCaret = true
      caretNodeText = node.getTextContent()
      continue
    }
    const text = authoredText(node)
    if (text === null) continue
    if (seenCaret) afterParts.push(text)
    else beforeParts.push(text)
  }
  if (!seenCaret) return null

  const before = [...beforeParts, caretNodeText.slice(0, inNodeOffset)].join('\n')
  const after = [caretNodeText.slice(inNodeOffset), ...afterParts].join('\n')
  return {
    prefix: before.slice(-AUTOCOMPLETE_MAX_PREFIX_CHARS),
    suffix: after.slice(0, AUTOCOMPLETE_MAX_SUFFIX_CHARS),
    anchor: anchorToken
  }
}
