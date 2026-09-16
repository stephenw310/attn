// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $isTableCellNode, $isTableNode } from '@lexical/table'
import { $getRoot, type LexicalEditor } from 'lexical'
import { expect, it } from 'vitest'
import { normalizeClipboardHtml } from '../clipboardHtml'
import { editorConfig } from '../editorConfig'
import { prepareHtmlForEditor } from '../preserve'
import { sanitizeOutgoingHtml } from '../sanitize'
import { ComposerTableCellNode } from './ComposerTableCellNode'
import { ComposerTableNode } from './ComposerTableNode'

function editorWith(html: string): LexicalEditor {
  const editor = createHeadlessEditor({
    nodes: editorConfig.nodes,
    onError: (error) => {
      throw error
    }
  })
  editor.update(
    () => {
      $getRoot().append(...$generateNodesFromDOM(editor, new DOMParser().parseFromString(html, 'text/html')))
    },
    { discrete: true }
  )
  return editor
}

function save(editor: LexicalEditor): string {
  let html = ''
  editor.getEditorState().read(() => {
    html = sanitizeOutgoingHtml($generateHtmlFromNodes(editor))
  })
  return html
}

function cellWidths(editor: LexicalEditor): (number | undefined)[] {
  const widths: (number | undefined)[] = []
  editor.getEditorState().read(() => {
    for (const text of $getRoot().getAllTextNodes()) {
      const cell = text.getParent()?.getParent()
      if ($isTableCellNode(cell)) widths.push(cell.getWidth())
    }
  })
  return widths
}

const notionTable =
  '<table><thead><tr><th>Work stream</th><th>Budget</th></tr></thead><tbody><tr><td>Optimize existing product to convert new users</td><td>50%</td></tr></tbody></table>'

it('imports pasted tables as the composer table nodes', () => {
  const editor = editorWith(prepareHtmlForEditor(normalizeClipboardHtml(notionTable)).html)
  editor.getEditorState().read(() => {
    const table = $getRoot().getFirstChild()
    expect($isTableNode(table)).toBe(true)
    expect(table).toBeInstanceOf(ComposerTableNode)
    const cell = $getRoot().getAllTextNodes()[0]?.getParent()?.getParent()
    expect(cell).toBeInstanceOf(ComposerTableCellNode)
  })
})

it('saves a table without widths the source never set, and reopens it the same way', () => {
  const pasted = prepareHtmlForEditor(normalizeClipboardHtml(notionTable))
  expect(pasted.issues).toEqual([])
  const saved = save(editorWith(pasted.html))
  expect(saved).not.toContain('width')
  expect(saved).not.toContain('solid black')
  expect(saved).not.toContain('text-align: start')
  expect(saved).not.toContain('rgb(242, 243, 245)')
  expect(saved).toContain('<table style="border-collapse: collapse">')
  expect(saved.split('border: 1px solid rgb(201, 208, 214)')).toHaveLength(5)
  expect(saved.match(/padding: 6px 8px/g)).toHaveLength(4)

  const reopened = prepareHtmlForEditor(saved)
  expect(reopened.issues).toEqual([])
  const editor = editorWith(reopened.html)
  expect(cellWidths(editor)).toEqual([undefined, undefined, undefined, undefined])
  expect(save(editor)).toBe(saved)
})

it('keeps a cell width the source set', () => {
  const pasted = prepareHtmlForEditor(
    normalizeClipboardHtml(
      '<table><tbody><tr><td style="width: 200px">Wide</td><td>Narrow</td></tr></tbody></table>'
    )
  )
  const saved = save(editorWith(pasted.html))
  expect(saved).toContain('width: 200px')
  expect(saved.match(/width:/g)).toHaveLength(1)
  expect(cellWidths(editorWith(prepareHtmlForEditor(saved).html))).toEqual([200, undefined])
})

it('keeps an authored header background', () => {
  const saved = save(
    editorWith(
      prepareHtmlForEditor(
        '<table><tbody><tr><th style="background-color: rgb(255, 240, 120)">Head</th></tr></tbody></table>'
      ).html
    )
  )
  expect(saved).toContain('background-color: rgb(255, 240, 120)')
})
