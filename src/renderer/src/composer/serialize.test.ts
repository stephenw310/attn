// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createQuoteNode, QuoteNode } from '@lexical/rich-text'
import { $createParagraphNode, $createTextNode, $getRoot, type SerializedEditorState } from 'lexical'
import { describe, expect, it } from 'vitest'
import { prepareHtmlForEditor } from './preserve'
import { editorStateToPlainText } from './serialize'

describe('plain-text alternative', () => {
  it('preserves list markers and quote prefixes from the editor model', () => {
    const editor = createHeadlessEditor({ nodes: [ListNode, ListItemNode, QuoteNode] })
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
    const editor = createHeadlessEditor({ nodes: [ListNode, ListItemNode] })
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
})
