// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $getRoot } from 'lexical'
import { expect, it } from 'vitest'
import { $clearSelectionFormatting } from './bodyEditing'
import { editorConfig } from './editorConfig'
import { prepareHtmlForEditor } from './preserve'

it('clear formatting lifts the cleared text out of a legacy font wrapper', () => {
  const editor = createHeadlessEditor({
    nodes: editorConfig.nodes,
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const html = prepareHtmlForEditor(
        '<p><font face="Arial" color="red"><b>Red Arial text</b></font> plain</p>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const [text] = $getRoot().getAllTextNodes()
      text.select(4, 9)
      $clearSelectionFormatting(editor)
      const output = $generateHtmlFromNodes(editor)
      const fonts = output.match(/<font[^>]*color="red"[^>]*>/g) ?? []
      expect(fonts).toHaveLength(2)
      expect(output).toMatch(/<\/font><span[^>]*>Arial<\/span><font/)
      expect(output).not.toMatch(/<strong[^>]*>Arial/)
      expect($getRoot().getTextContent()).toBe('Red Arial text plain')
    },
    { discrete: true }
  )
})

it('clear formatting lifts a linked run out of its legacy font wrapper', () => {
  const editor = createHeadlessEditor({
    nodes: editorConfig.nodes,
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const html = prepareHtmlForEditor(
        '<p><font color="red">Before <a href="https://x.test">Linked</a> after</font></p>'
      ).html
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
      const linked = $getRoot()
        .getAllTextNodes()
        .find((node) => node.getTextContent() === 'Linked')
      if (!linked) throw new Error('Missing link text')
      linked.select(0, 6)
      $clearSelectionFormatting(editor)
      const output = $generateHtmlFromNodes(editor)
      expect(output).toMatch(/<\/font>(?:<a[^>]*>)?<span[^>]*>Linked<\/span>(?:<\/a>)?<font/)
      expect($getRoot().getTextContent()).toBe('Before Linked after')
    },
    { discrete: true }
  )
})
