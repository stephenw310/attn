// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { editorConfig } from '../editorConfig'
import { prepareHtmlForEditor } from '../preserve'
import { preserveBlankLineBlocks, rootLevelNodes } from '../rootNodes'
import { serializeEditorState } from '../serialize'

const signature =
  '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div>Best,</div><div><font face="Arial">Alex Rivera</font></div></div>'

describe('Gmail signature separator', () => {
  it.each(['', 'white-space: nowrap; margin-left: 2px', 'white-space: pre-wrap; margin-left: 2px'])(
    'preserves the separator position, delimiter space, and authored style %j across saves',
    (style) => {
      let html = `<div dir="ltr"><div>Hello</div><div><br></div><span class="gmail_signature_prefix"${style ? ` style="${style}"` : ''}>-- </span><br>${signature}</div>`
      for (let roundTrip = 0; roundTrip < 3; roundTrip += 1) {
        const prepared = prepareHtmlForEditor(html)
        expect(prepared.issues).toEqual([])
        const document = new DOMParser().parseFromString(prepared.html, 'text/html')
        expect(document.querySelector('.gmail_signature > .gmail_signature_prefix')?.textContent).toBe('-- ')
        const editor = createHeadlessEditor({
          nodes: editorConfig.nodes,
          onError(error) {
            throw error
          }
        })
        editor.update(
          () => {
            preserveBlankLineBlocks(document)
            $getRoot().append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
          },
          { discrete: true }
        )
        const json = JSON.stringify(editor.getEditorState().toJSON())
        expect(json).toContain('gmail-signature-prefix')
        expect(json).not.toContain('opaque-html')
        editor.setEditorState(editor.parseEditorState(json))
        const saved = serializeEditorState(editor.getEditorState(), editor)
        expect(saved.bodyText).toBe('Hello\n\n-- \nBest,\nAlex Rivera')
        const exported = new DOMParser().parseFromString(saved.bodyHtml, 'text/html')
        const prefix = exported.querySelector('.gmail_signature_prefix')
        const exportedSignature = exported.querySelector('.gmail_signature')
        expect(exported.querySelectorAll('.gmail_signature_prefix')).toHaveLength(1)
        expect(prefix?.tagName).toBe('SPAN')
        expect(prefix?.textContent).toBe('-- ')
        expect(prefix?.getAttribute('style') ?? '').toBe(style)
        expect(prefix?.nextElementSibling?.tagName).toBe('BR')
        expect(prefix?.nextElementSibling?.nextElementSibling).toBe(exportedSignature)
        expect(exportedSignature?.contains(prefix)).toBe(false)
        expect(prefix?.parentElement?.previousElementSibling?.innerHTML).toBe('<br>')
        expect(exported.querySelectorAll('br')).toHaveLength(2)
        expect(exported.querySelector('font')?.getAttribute('face')).toBe('Arial')
        expect(saved.bodyHtml).not.toMatch(/iframe|data-attn-/)
        html = saved.bodyHtml
      }
    }
  )

  it('never hides ordinary dashes or text between a marked prefix and a signature', () => {
    for (const before of [
      '<span>-- </span><br>',
      '<span class="gmail_signature_prefix">-- </span><br><div>Keep this visible</div><br>'
    ]) {
      const prepared = prepareHtmlForEditor(before + signature)
      expect(prepared.issues).toEqual([])
      const document = new DOMParser().parseFromString(prepared.html, 'text/html')
      expect(document.querySelector('.gmail_signature')?.textContent).toBe('Best,Alex Rivera')
      expect(document.body.firstElementChild?.textContent).toBe('-- ')
    }
  })

  it('does not invent a separator when the supplied signature has none', () => {
    const prepared = prepareHtmlForEditor(`<div><br></div>${signature}`)
    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('gmail_signature_prefix')
    expect(prepared.html).not.toContain('--')
  })
})
