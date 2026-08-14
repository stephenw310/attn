import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createQuoteNode, QuoteNode } from '@lexical/rich-text'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
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
})
