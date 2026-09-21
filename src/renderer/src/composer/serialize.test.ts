// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { $createListItemNode, $createListNode } from '@lexical/list'
import { $createQuoteNode } from '@lexical/rich-text'
import { $createParagraphNode, $createTextNode, $getRoot, type SerializedEditorState } from 'lexical'
import { describe, expect, it } from 'vitest'
import { plainTextToDraftHtml } from '../../../shared/html'
import { editorConfig } from './editorConfig'
import { GmailSignatureNode } from './nodes/GmailSignatureNode'
import { $createImageNode, ImageNode } from './nodes/ImageNode'
import { prepareHtmlForEditor } from './preserve'
import { preserveBlankLineBlocks, rootLevelNodes } from './rootNodes'
import { editorStateToPlainText, serializeEditorState } from './serialize'

/** Everything the composer does between a stored body and a mounted editor. */
function loadDraftBody(bodyHtml: string): { bodyHtml: string; bodyText: string } {
  const editor = createHeadlessEditor({ nodes: editorConfig.nodes })
  const document = new DOMParser().parseFromString(prepareHtmlForEditor(bodyHtml).html, 'text/html')
  preserveBlankLineBlocks(document)
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      root.append(...rootLevelNodes($generateNodesFromDOM(editor, document)))
    },
    { discrete: true }
  )
  return serializeEditorState(editor.getEditorState(), editor)
}

describe('plain-text alternative', () => {
  it('exports editor paragraphs as Gmail div rows', () => {
    const editor = createHeadlessEditor()
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('First row')),
          $createParagraphNode(),
          $createParagraphNode().append($createTextNode('Second row'))
        )
      },
      { discrete: true }
    )

    const { bodyHtml } = serializeEditorState(editor.getEditorState(), editor)
    const document = new DOMParser().parseFromString(bodyHtml, 'text/html')
    const root = document.body.firstElementChild
    expect(root?.getAttribute('dir')).toBe('ltr')
    expect([...(root?.children ?? [])].map((element) => element.tagName)).toEqual(['DIV', 'DIV', 'DIV'])
    expect(root?.children[1]?.innerHTML).toBe('<br>')
  })

  it('wraps a marked signature in the dedicated block Gmail sends', () => {
    const editor = createHeadlessEditor({ nodes: editorConfig.nodes })
    editor.update(
      () => {
        const signature = new GmailSignatureNode().append(
          $createParagraphNode().append($createTextNode('Best,')),
          $createParagraphNode().append($createTextNode('Alex Morgan'))
        )
        $getRoot().append($createParagraphNode().append($createTextNode('Hello')), signature)
      },
      { discrete: true }
    )

    const { bodyHtml, bodyText } = serializeEditorState(editor.getEditorState(), editor)
    const document = new DOMParser().parseFromString(bodyHtml, 'text/html')
    const signature = document.querySelector('.gmail_signature')
    const wrapper = signature?.parentElement
    expect(signature?.getAttribute('dir')).toBe('ltr')
    expect(wrapper?.tagName).toBe('DIV')
    expect(wrapper?.previousElementSibling?.innerHTML).toBe('<br>')
    expect(wrapper?.parentElement?.getAttribute('dir')).toBe('ltr')
    expect(wrapper?.parentElement?.parentElement).toBe(document.body)
    expect(wrapper?.children).toHaveLength(1)
    expect(bodyText).toBe('Hello\n\nBest,\nAlex Morgan')
  })

  it('serializes inline images to CID without leaking the private marker', () => {
    const editor = createHeadlessEditor({ nodes: [ImageNode] })
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createImageNode('data:image/png;base64,iVBORw0KGgo=', 'image@attn.local', 'a > b', 120, 80)
          )
        )
      },
      { discrete: true }
    )

    const { bodyHtml } = serializeEditorState(editor.getEditorState(), editor)
    expect(bodyHtml).toContain('src="cid:image@attn.local"')
    expect(bodyHtml).toContain('alt="a > b"')
    expect(bodyHtml).toContain('width="120"')
    expect(bodyHtml).toContain('height="80"')
    expect(bodyHtml).not.toContain('data-attn-cid')
    expect(bodyHtml).not.toContain('data:image')
  })

  it('restores remote image sources at string level without leaking the swap marker', () => {
    // exportDOM keeps remote URLs off its live-document element (a src there
    // fires a real request on every serialization — PR #101 review); the
    // saved body must still carry the real source, marker-free.
    const editor = createHeadlessEditor({ nodes: [ImageNode] })
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createImageNode('https://mail.example.test/pixel.png', '', 'remote pixel', 24, 24)
          )
        )
      },
      { discrete: true }
    )

    const { bodyHtml } = serializeEditorState(editor.getEditorState(), editor)
    expect(bodyHtml).toContain('src="https://mail.example.test/pixel.png"')
    expect(bodyHtml).not.toContain('data-attn-remote-src')
    expect(bodyHtml).not.toContain('data:image/gif')
  })

  it('preserves list markers and quote prefixes from the editor model', () => {
    const editor = createHeadlessEditor({ nodes: editorConfig.nodes })
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Hello')),
          $createListNode('number').append(
            $createListItemNode().append($createTextNode('First')),
            $createListItemNode().append($createTextNode('Second'))
          ),
          $createQuoteNode().append($createTextNode('Earlier\nmessage'))
        )
      },
      { discrete: true }
    )

    expect(editorStateToPlainText(editor.getEditorState().toJSON())).toBe(
      'Hello\n1. First\n2. Second\n> Earlier\n> message'
    )
  })

  it('preserves nested list markers and indentation', () => {
    const editor = createHeadlessEditor({ nodes: editorConfig.nodes })
    editor.update(
      () => {
        const parent = $createListItemNode().append($createTextNode('Parent'))
        parent.append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('Child')),
            $createListItemNode().append($createTextNode('Child 2'))
          )
        )
        $getRoot().append(
          $createListNode('number').append(parent, $createListItemNode().append($createTextNode('Second')))
        )
      },
      { discrete: true }
    )

    expect(editorStateToPlainText(editor.getEditorState().toJSON())).toBe(
      '1. Parent\n  - Child\n  - Child 2\n2. Second'
    )
  })

  it('includes preserved opaque-region text in the plain-text alternative', () => {
    const prepared = prepareHtmlForEditor(
      '<section data-layout="card"><mark>Preserved words</mark></section>'
    )
    const encoded = /data-attn-opaque="([A-Za-z0-9_-]+)"/.exec(prepared.html)?.[1]
    expect(encoded).toBeTruthy()
    expect(
      editorStateToPlainText({
        root: {
          children: [
            {
              type: 'opaque-html',
              version: 1,
              html: encoded,
              inline: false
            }
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1
        }
      } as unknown as SerializedEditorState)
    ).toBe('Preserved words')
  })

  it('includes the registered styled text replacement in the plain-text alternative', () => {
    expect(
      editorStateToPlainText({
        root: {
          children: [
            {
              type: 'paragraph',
              version: 1,
              children: [{ type: 'styled-text', version: 1, text: 'Styled body' }]
            }
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1
        }
      } as unknown as SerializedEditorState)
    ).toBe('Styled body')
  })

  it('keeps editable Gmail signature rows separated in the plain-text alternative', () => {
    expect(
      editorStateToPlainText({
        root: {
          children: [
            {
              type: 'gmail-signature',
              version: 1,
              children: [
                {
                  type: 'paragraph',
                  version: 1,
                  children: [{ type: 'styled-text', version: 1, text: 'Best,' }]
                },
                {
                  type: 'paragraph',
                  version: 1,
                  children: [{ type: 'styled-text', version: 1, text: 'Alex Morgan' }]
                },
                {
                  type: 'paragraph',
                  version: 1,
                  children: [
                    {
                      type: 'link',
                      version: 1,
                      children: [{ type: 'styled-text', version: 1, text: 'https://alexmorgan.example' }]
                    }
                  ]
                }
              ]
            }
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1
        }
      } as unknown as SerializedEditorState)
    ).toBe('\nBest,\nAlex Morgan\nhttps://alexmorgan.example')
  })
})

describe('mailto body prefill', () => {
  it('round-trips a multi-line plain body through the editor unchanged', () => {
    const text = 'First line\n\nSecond line\nThird line'
    const loaded = loadDraftBody(plainTextToDraftHtml(text))
    expect(loaded.bodyText).toBe(text)
    // The editor adds its own `white-space` span around text, so the markup is
    // compared by structure: one row per line, `<br>` for the blank one.
    const root = new DOMParser().parseFromString(loaded.bodyHtml, 'text/html').body.firstElementChild
    expect(root?.getAttribute('dir')).toBe('ltr')
    expect([...(root?.children ?? [])].map((row) => row.textContent)).toEqual([
      'First line',
      '',
      'Second line',
      'Third line'
    ])
    // Saving the loaded body and opening it again changes nothing further.
    expect(loadDraftBody(loaded.bodyHtml)).toEqual(loaded)
  })

  it('keeps markup in a link body as text on both sides of the round trip', () => {
    const loaded = loadDraftBody(plainTextToDraftHtml('<img src=x onerror=alert(1)>'))
    expect(loaded.bodyText).toBe('<img src=x onerror=alert(1)>')
    expect(loaded.bodyHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(new DOMParser().parseFromString(loaded.bodyHtml, 'text/html').querySelector('img')).toBeNull()
  })
})
