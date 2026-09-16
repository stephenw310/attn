// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $getRoot, TextNode } from 'lexical'
import { expect, it } from 'vitest'
import { normalizeClipboardHtml } from '../clipboardHtml'
import { editorConfig } from '../editorConfig'
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
        '<p><b><span style="font-weight:normal">Reset bold</span></b><i><span style="font-style:normal">Reset italic</span></i><u><span style="text-decoration:none">Keep underline</span></u></p><p style="font-weight:normal"><b>Keep bold</b></p>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const nodes = $getRoot().getAllTextNodes()
      for (const node of nodes.filter((node) => node.getTextContent().includes('Reset'))) {
        expect(node.hasFormat('bold')).toBe(false)
        expect(node.hasFormat('italic')).toBe(false)
        expect(node.hasFormat('underline')).toBe(false)
      }
      const underlined = nodes.find((node) => node.getTextContent() === 'Keep underline')
      expect(underlined?.hasFormat('underline')).toBe(true)
      underlined?.toggleFormat('underline')
      expect(underlined?.hasFormat('underline')).toBe(false)
      expect(nodes.at(-1)?.hasFormat('bold')).toBe(true)
      const output = $generateHtmlFromNodes(editor)
      expect(output).not.toMatch(/<strong[^>]*>Reset/)
    },
    { discrete: true }
  )
})

it('honors decoration overrides on the decorated element and unions nested block lines', () => {
  const editor = createHeadlessEditor({
    nodes: editorConfig.nodes,
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const html = prepareHtmlForEditor(
        '<p><u style="text-decoration:none">Plain</u><s style="text-decoration:underline">Swapped</s></p><div style="text-decoration:underline"><p style="text-decoration:line-through">Both</p><p><span style="text-decoration:overline">Mixed</span></p></div>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const [plain, swapped, both, mixed] = $getRoot().getAllTextNodes()
      expect([plain.hasFormat('underline'), plain.hasFormat('strikethrough')]).toEqual([false, false])
      expect([swapped.hasFormat('underline'), swapped.hasFormat('strikethrough')]).toEqual([true, false])
      expect([both.hasFormat('underline'), both.hasFormat('strikethrough')]).toEqual([true, true])
      // An exotic declaration keeps the propagated line beside it.
      expect(mixed.getStyle()).toContain('overline')
      expect(mixed.getStyle()).toContain('underline')
    },
    { discrete: true }
  )
})

it('preserves a box shared by several text runs as one opaque region', () => {
  const box = 'background-color:yellow; border:2px solid red; padding:4px'
  const shared = `<p><span style="${box}"><b>A</b><i>B</i>C</span></p>`
  const prepared = prepareHtmlForEditor(shared)
  expect(prepared.issues).toHaveLength(1)
  expect(restoreOpaqueHtml(prepared.html)).toBe(shared)
  // A single run keeps its box editable: stored drafts and Gmail's own
  // signature separator (`margin-left: 2px`) rely on it.
  for (const style of [box, 'white-space: nowrap; margin-left: 2px']) {
    const single = prepareHtmlForEditor(`<p><span style="${style}">Highlight</span></p>`)
    expect(single.issues).toEqual([])
    expect(single.html).not.toContain('data-attn-opaque')
  }
})

it('keeps a normal weight that cancels emphasis the exported HTML still carries', () => {
  const editor = createHeadlessEditor({
    nodes: editorConfig.nodes,
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const html = prepareHtmlForEditor(
        '<table><tr><th><span style="font-weight:normal">Header</span></th></tr></table><p><span style="font-size:14px"><b><span style="font-weight:normal">Nested</span></b></span></p><p><span style="font-weight:normal">Plain</span></p>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const output = $generateHtmlFromNodes(editor)
      expect(output).toMatch(/font-weight: normal[^>]*>Header/)
      expect(output).toMatch(/font-weight: normal[^>]*>Nested/)
      // A default weight with nothing to cancel stays out of the way of the toolbar.
      expect(output).toMatch(/<span style="white-space: pre-wrap;">Plain/)
    },
    { discrete: true }
  )
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
