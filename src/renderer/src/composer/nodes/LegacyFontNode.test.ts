// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { editorConfig } from '../editorConfig'
import { prepareHtmlForEditor, restoreOpaqueHtml } from '../preserve'
import { rootLevelNodes } from '../rootNodes'
import { serializeEditorState } from '../serialize'
import { LegacyFontNode } from './LegacyFontNode'

describe('legacy Gmail font import', () => {
  it('keeps nested font attributes, links, and text editable through HTML and JSON round trips', () => {
    const html =
      '<p><font face="Georgia, serif" color="#123456" size="+2" title="Saved font" dir="rtl">' +
      'Hello <a href="https://attn.test">site</a> <font face="Arial" size="1">small</font>' +
      '</font></p>'
    const prepared = prepareHtmlForEditor(html)
    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    const editor = createHeadlessEditor({
      nodes: editorConfig.nodes,
      onError(error) {
        throw error
      }
    })
    editor.update(
      () => {
        const document = new DOMParser().parseFromString(prepared.html, 'text/html')
        $getRoot().append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
      },
      { discrete: true }
    )
    const serialized = JSON.stringify(editor.getEditorState().toJSON())
    expect(serialized).toContain('legacy-font')
    expect(serialized).not.toContain('opaque-html')
    editor.setEditorState(editor.parseEditorState(serialized))
    const { bodyHtml, bodyText } = serializeEditorState(editor.getEditorState(), editor)
    const document = new DOMParser().parseFromString(bodyHtml, 'text/html')
    const font = document.querySelector('font')
    expect(font?.getAttribute('face')).toBe('Georgia, serif')
    expect(font?.getAttribute('color')).toBe('#123456')
    expect(font?.getAttribute('size')).toBe('+2')
    expect(font?.getAttribute('title')).toBe('Saved font')
    expect(font?.getAttribute('dir')).toBe('rtl')
    expect(font?.querySelector('a')?.getAttribute('href')).toBe('https://attn.test')
    expect(font?.querySelector('font')?.getAttribute('face')).toBe('Arial')
    expect(font?.querySelector('font')?.getAttribute('size')).toBe('1')
    expect(bodyText).toBe('Hello site small')
  })

  it('still preserves font markup that has unsupported attributes as an exact opaque region', () => {
    const html = '<font face="Arial" data-layout="badge">Keep the custom formatting</font>'
    const prepared = prepareHtmlForEditor(html)
    expect(prepared.issues).toContain('font[data-layout]')
    expect(restoreOpaqueHtml(prepared.html)).toBe(html)
  })

  it.each(['auto', 'ltr', 'rtl', null])(
    'preserves font direction %j through edits and repeated saves',
    (direction) => {
      let html = `<div dir="ltr"><font face="Arial"${direction ? ` dir="${direction}"` : ''}>שלום Alex</font></div>`
      for (let roundTrip = 0; roundTrip < 3; roundTrip += 1) {
        const prepared = prepareHtmlForEditor(html)
        expect(prepared.issues).toEqual([])
        const editor = createHeadlessEditor({
          nodes: editorConfig.nodes,
          onError(error) {
            throw error
          }
        })
        editor.update(
          () => {
            const document = new DOMParser().parseFromString(prepared.html, 'text/html')
            $getRoot().append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
          },
          { discrete: true }
        )
        // A later update clones the font node; both that clone and JSON must retain auto direction.
        editor.update(
          () => {
            const font = $getRoot().getAllTextNodes()[0].getParentOrThrow()
            expect(font).toBeInstanceOf(LegacyFontNode)
            font.setStyle('margin-left: 2px')
            const element = font.createDOM(editor._config, editor)
            expect(font.getDOMSlot(element).element.getAttribute('dir')).toBe(direction)
          },
          { discrete: true }
        )
        const json = JSON.stringify(editor.getEditorState().toJSON())
        expect(json).not.toContain('opaque-html')
        editor.setEditorState(editor.parseEditorState(json))
        const saved = serializeEditorState(editor.getEditorState(), editor)
        const document = new DOMParser().parseFromString(saved.bodyHtml, 'text/html')
        expect(document.querySelector('font')?.getAttribute('dir')).toBe(direction)
        expect(saved.bodyText).toBe('שלום Alex')
        html = saved.bodyHtml
      }
    }
  )
})
