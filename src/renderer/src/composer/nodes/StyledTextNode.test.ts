// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $getRoot, TextNode } from 'lexical'
import { expect, it } from 'vitest'
import { normalizeClipboardHtml } from '../clipboardHtml'
import { prepareHtmlForEditor, restoreOpaqueHtml } from '../preserve'
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

it('applies inner normal resets while preserving semantic emphasis inside a normal parent', () => {
  const editor = createHeadlessEditor({
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
      const html = prepareHtmlForEditor(
        '<p><b><span style="font-weight:normal">Reset bold</span></b><i><span style="font-style:normal">Reset italic</span></i><u><span style="text-decoration:none">Keep underline</span></u><s><span style="text-decoration:none">Keep strike</span></s><u style="text-decoration:none">Reset own underline</u><s style="text-decoration:none">Reset own strike</s><u style="text-decoration:none solid rgb(0, 0, 0)">Reset computed underline</u></p><p style="font-weight:normal"><b>Keep bold</b></p>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const nodes = $getRoot().getAllTextNodes()
      for (const node of nodes.filter((node) => node.getTextContent().includes('Reset'))) {
        expect(node.hasFormat('bold')).toBe(false)
        expect(node.hasFormat('italic')).toBe(false)
        expect(node.hasFormat('underline')).toBe(false)
        expect(node.hasFormat('strikethrough')).toBe(false)
      }
      expect(nodes.find((node) => node.getTextContent() === 'Keep underline')?.hasFormat('underline')).toBe(
        true
      )
      expect(nodes.find((node) => node.getTextContent() === 'Keep strike')?.hasFormat('strikethrough')).toBe(
        true
      )
      expect(nodes.at(-1)?.hasFormat('bold')).toBe(true)
      const output = $generateHtmlFromNodes(editor)
      expect(output).not.toMatch(/<strong[^>]*>Reset/)
    },
    { discrete: true }
  )
})

it('preserves a shared box as one opaque region instead of duplicating it over text runs', () => {
  for (const contents of ['<b>A</b><i>B</i>C', 'Highlight']) {
    const source = `<span style="background-color:yellow; border:2px solid red; padding:4px">${contents}</span>`
    const prepared = prepareHtmlForEditor(`<p>${source}</p>`)
    expect(prepared.issues).toHaveLength(1)
    expect(restoreOpaqueHtml(prepared.html)).toBe(`<p>${source}</p>`)
  }
})

it('keeps code typography on every preformatted line and tab', () => {
  const editor = createHeadlessEditor({
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
      const html = prepareHtmlForEditor(normalizeClipboardHtml('<pre>one\ntwo\tthree</pre>')).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      expect($getRoot().getTextContent()).toBe('one\ntwo\tthree')
      for (const node of $getRoot().getAllTextNodes()) expect(node.getStyle()).toContain('monospace')
      const exported = new DOMParser().parseFromString($generateHtmlFromNodes(editor), 'text/html')
      for (const span of exported.querySelectorAll('span')) {
        if (span.textContent?.trim()) expect(span.style.fontFamily).toBe('monospace')
      }
    },
    { discrete: true }
  )
})
