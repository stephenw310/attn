// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $getRoot } from 'lexical'
import { expect, it } from 'vitest'
import { $insertPlainClipboardText } from './clipboardText'

it('keeps the destination format and style across plain clipboard lines and tabs', () => {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      const paragraph = $createParagraphNode()
      $getRoot().append(paragraph)
      const selection = paragraph.selectEnd()
      selection.toggleFormat('bold')
      selection.setStyle('color: red; font-family: Georgia; font-size: 20px')
      $insertPlainClipboardText(selection, 'One\r\nTwo\t<b>literal</b>')
      expect($getRoot().getTextContent()).toBe('One\nTwo\t<b>literal</b>')
      for (const node of $getRoot().getAllTextNodes()) {
        expect(node.hasFormat('bold')).toBe(true)
        expect(node.getStyle()).toContain('color: red')
        expect(node.getStyle()).toContain('Georgia')
      }
    },
    { discrete: true }
  )
})
