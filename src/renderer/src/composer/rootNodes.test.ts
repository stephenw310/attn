// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { QuoteNode } from '@lexical/rich-text'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { $getRoot, TextNode } from 'lexical'
import { describe, expect, it } from 'vitest'
import { GmailSignatureNode } from './nodes/GmailSignatureNode'
import { GmailSignaturePrefixNode } from './nodes/GmailSignaturePrefixNode'
import { ImageNode } from './nodes/ImageNode'
import { LegacyFontNode } from './nodes/LegacyFontNode'
import { OpaqueHtmlNode } from './nodes/OpaqueHtmlNode'
import { StyledTextNode } from './nodes/StyledTextNode'
import { prepareHtmlForEditor } from './preserve'
import { preserveBlankLineBlocks, rootLevelNodes } from './rootNodes'
import { editorStateToPlainText } from './serialize'

// The composer's own registry: node types decide what `$generateNodesFromDOM`
// returns, so a narrower list would not exercise the real import.
function editor() {
  return createHeadlessEditor({
    namespace: 'attn-composer',
    nodes: [
      LinkNode,
      ListNode,
      ListItemNode,
      QuoteNode,
      TableNode,
      TableRowNode,
      TableCellNode,
      ImageNode,
      GmailSignatureNode,
      GmailSignaturePrefixNode,
      LegacyFontNode,
      OpaqueHtmlNode,
      StyledTextNode,
      {
        replace: TextNode,
        with: (node: TextNode) => new StyledTextNode(node.getTextContent()),
        withKlass: StyledTextNode
      }
    ],
    onError(error) {
      throw error
    }
  })
}

/** Load HTML exactly as `InitialHtmlPlugin` does, returning the root's child types. */
function loadDraftHtml(html: string): string[] {
  const target = editor()
  let types: string[] = []
  target.update(
    () => {
      const document = new DOMParser().parseFromString(prepareHtmlForEditor(html).html, 'text/html')
      preserveBlankLineBlocks(document)
      const root = $getRoot()
      root.clear()
      root.append(...rootLevelNodes($generateNodesFromDOM(target, document)))
      types = root.getChildren().map((child) => child.getType())
    },
    { discrete: true }
  )
  return types
}

function loadDraftText(html: string): string {
  const target = editor()
  target.update(
    () => {
      const document = new DOMParser().parseFromString(prepareHtmlForEditor(html).html, 'text/html')
      preserveBlankLineBlocks(document)
      $getRoot().append(...rootLevelNodes($generateNodesFromDOM(target, document)))
    },
    { discrete: true }
  )
  return editorStateToPlainText(target.getEditorState().toJSON())
}

describe('root-level node normalization', () => {
  it('loads a reply body whose signature and quoted trail are split by a bare line break', () => {
    // The shape every Gmail reply draft written before the inline-reply change
    // carries: body, signature, a top-level <br>, then the quoted history.
    const html =
      '<div>Sounds good.</div>' +
      '<div class="gmail_signature">Chao</div>' +
      '<br>' +
      '<blockquote class="gmail_quote"><div>Earlier message</div></blockquote>'

    expect(() => loadDraftHtml(html)).not.toThrow()
    expect(loadDraftHtml(html)).not.toContain('linebreak')
  })

  it('keeps block structure and ordering intact around wrapped inline runs', () => {
    expect(loadDraftHtml('<p>One</p><br>bare text<p>Two</p>')).toEqual([
      'paragraph',
      'paragraph',
      'paragraph'
    ])
  })

  it('leaves output that is already element-only untouched', () => {
    expect(loadDraftHtml('<p>One</p><blockquote>Two</blockquote>')).toEqual(['paragraph', 'quote'])
  })

  it("keeps Gmail's blank row between authored text and its signature", () => {
    const html =
      '<div dir="ltr"><div>Hi there,</div><div>This is a test of email format.</div>' +
      '<div>Hopefully it looks good</div><div><br></div><div>' +
      '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">' +
      '<div dir="ltr"><div>Bests,</div>Chao Wu<div><a href="https://chaowu.xyz">' +
      'https://chaowu.xyz</a><br></div></div></div></div></div>'

    expect(loadDraftText(html)).toBe(
      'Hi there,\nThis is a test of email format.\nHopefully it looks good\n\nBests,\nChao Wu\nhttps://chaowu.xyz'
    )
  })
})
