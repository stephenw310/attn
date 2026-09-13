// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $getRoot, TextNode } from 'lexical'
import { expect, it } from 'vitest'
import { prepareHtmlForEditor } from '../preserve'
import { StyledTextNode } from './StyledTextNode'

it('imports CSS and semantic emphasis as editable formats without overriding toolbar changes', () => {
  const editor = createHeadlessEditor({
    namespace: 'styled-text',
    nodes: [
      StyledTextNode,
      {
        replace: TextNode,
        with: (node: TextNode) => new StyledTextNode(node.getTextContent()),
        withKlass: StyledTextNode
      }
    ],
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const html =
        prepareHtmlForEditor(`<p style="font-weight: normal; font-style: normal; font-size: 13px"><b>Semantic bold</b></p>
      <p><span style="font-weight:700; font-style:italic; text-decoration:underline">CSS emphasis</span></p>`).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const [semantic, css] = $getRoot().getAllTextNodes()
      expect(semantic.hasFormat('bold')).toBe(true)
      expect(semantic.getStyle()).not.toContain('font-weight')
      expect(semantic.getStyle()).toContain('13px')
      for (const format of ['bold', 'italic', 'underline'] as const) {
        expect(css.hasFormat(format)).toBe(true)
        css.toggleFormat(format)
        expect(css.hasFormat(format)).toBe(false)
      }
      expect(css.getStyle()).toBe('')
      semantic.toggleFormat('bold')
      expect(semantic.hasFormat('bold')).toBe(false)
    },
    { discrete: true }
  )
})

it('retains CSS emphasis that format flags cannot fully represent through HTML export', () => {
  const editor = createHeadlessEditor({
    namespace: 'css-emphasis',
    nodes: [
      StyledTextNode,
      {
        replace: TextNode,
        with: (node: TextNode) => new StyledTextNode(node.getTextContent()),
        withKlass: StyledTextNode
      }
    ],
    onError: (error) => {
      throw error
    }
  })
  const styles = [
    'text-decoration: overline',
    'text-decoration: underline dotted red',
    'font-weight: 500',
    'font-style: oblique 10deg'
  ]
  editor.update(
    () => {
      const html = prepareHtmlForEditor(
        styles.map((style, i) => `<p><span style="${style}">Sample ${i}</span></p>`).join('')
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const texts = $getRoot().getAllTextNodes()
      for (const [i, style] of styles.entries()) expect(texts[i].getStyle()).toContain(style)
      const exported = $generateHtmlFromNodes(editor)
      for (const style of styles) expect(exported).toContain(style)
    },
    { discrete: true }
  )
})
