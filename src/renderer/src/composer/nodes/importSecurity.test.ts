// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { $createParagraphNode, $getRoot, type SerializedLexicalNode, TextNode } from 'lexical'
import { describe, expect, it } from 'vitest'
import { decodeOpaqueHtml, encodeOpaqueHtml } from '../preserve'
import { rootLevelNodes } from '../rootNodes'
import { serializeEditorState } from '../serialize'
import { ImageNode, type SerializedImageNode } from './ImageNode'
import { OpaqueHtmlNode, type SerializedOpaqueHtmlNode } from './OpaqueHtmlNode'
import { StyledTextNode } from './StyledTextNode'

interface SerializedNodeRecord extends SerializedLexicalNode {
  children?: SerializedNodeRecord[]
  html?: string
  src?: string
  style?: string
}

const unsafeOpaqueHtml =
  '<section><p>Safe text</p><script>alert(1)</script>' +
  '<img src="javascript:alert(2)" onerror="alert(3)" style="position:fixed;color:red"></section>'
const unsafeStyle = 'position:fixed; color: red; background-image:url(javascript:alert(4)); width:20px'

function composerEditor() {
  return createHeadlessEditor({
    namespace: 'attn-composer',
    nodes: [
      ImageNode,
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

function nodeByType(root: SerializedNodeRecord, type: string): SerializedNodeRecord {
  if (root.type === type) return root
  for (const child of root.children ?? []) {
    const match = nodeByTypeOrNull(child, type)
    if (match) return match
  }
  throw new Error(`missing ${type} node`)
}

function nodeByTypeOrNull(root: SerializedNodeRecord, type: string): SerializedNodeRecord | null {
  if (root.type === type) return root
  for (const child of root.children ?? []) {
    const match = nodeByTypeOrNull(child, type)
    if (match) return match
  }
  return null
}

function expectSafeState(editor: ReturnType<typeof composerEditor>): void {
  const state = editor.getEditorState()
  const root = state.toJSON().root as SerializedNodeRecord
  const opaque = nodeByType(root, 'opaque-html')
  const image = nodeByType(root, 'composer-image')
  const styled = nodeByType(root, 'styled-text')
  const decoded = decodeOpaqueHtml(opaque.html ?? '')

  expect(decoded).toContain('Safe text')
  expect(decoded).not.toMatch(/<script|onerror|javascript:|position\s*:/i)
  expect(image.src).toBe('')
  expect(image.style).toBe('color: red; width:20px')
  expect(styled.style).toBe('color: red; width:20px')

  const { bodyHtml } = serializeEditorState(state, editor)
  expect(bodyHtml).toContain('Safe text')
  expect(bodyHtml).not.toMatch(/<script|onerror|javascript:|position\s*:/i)
}

describe('composer node import security', () => {
  it('preserves safe opaque source bytes through DOM import and serialization', () => {
    const source = "<SECTION DATA-LAYOUT='card'><MARK>Keep&nbsp;this</MARK></SECTION>"
    const encoded = encodeOpaqueHtml(source)
    const editor = composerEditor()
    const document = new DOMParser().parseFromString(`<div data-attn-opaque="${encoded}"></div>`, 'text/html')
    editor.update(
      () => {
        $getRoot().append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
      },
      { discrete: true }
    )

    const root = editor.getEditorState().toJSON().root as SerializedNodeRecord
    expect(nodeByType(root, 'opaque-html').html).toBe(encoded)
    expect(serializeEditorState(editor.getEditorState(), editor).bodyHtml).toBe(source)
  })

  it('sanitizes crafted Lexical JSON before storing custom node fields', () => {
    const editor = composerEditor()
    editor.update(
      () => {
        const opaque = OpaqueHtmlNode.importJSON({
          type: 'opaque-html',
          version: 1,
          html: encodeOpaqueHtml(unsafeOpaqueHtml),
          inline: false
        } satisfies SerializedOpaqueHtmlNode)
        const image = ImageNode.importJSON({
          type: 'composer-image',
          version: 1,
          src: 'javascript:alert(5)',
          contentId: '',
          altText: 'Unsafe image',
          width: null,
          height: null,
          style: unsafeStyle,
          dataSurl: ''
        } satisfies SerializedImageNode)
        const styled = StyledTextNode.importJSON({
          type: 'styled-text',
          version: 1,
          text: 'Styled text',
          detail: 0,
          format: 0,
          mode: 'normal',
          style: unsafeStyle
        })
        $getRoot().append(opaque, $createParagraphNode().append(image, styled))
      },
      { discrete: true }
    )

    expectSafeState(editor)
  })

  it('sanitizes the same fields when Lexical imports DOM nodes directly', () => {
    const editor = composerEditor()
    const document = new DOMParser().parseFromString(
      `<div data-attn-opaque="${encodeOpaqueHtml(unsafeOpaqueHtml)}"></div>` +
        `<p><img src="javascript:alert(5)" style="${unsafeStyle}">` +
        `<span style="${unsafeStyle}">Styled text</span></p>`,
      'text/html'
    )
    editor.update(
      () => {
        $getRoot().append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
      },
      { discrete: true }
    )

    expectSafeState(editor)
  })
})
