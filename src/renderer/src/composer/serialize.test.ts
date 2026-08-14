import { createHeadlessEditor } from '@lexical/headless'
import { withDOM } from '@lexical/headless/dom'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createQuoteNode, QuoteNode } from '@lexical/rich-text'
import type { WindowLike } from 'dompurify'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { describe, expect, it } from 'vitest'
import { editorStateToPlainText, sanitizeOutgoingHtml } from './serialize'

describe('outgoing HTML sanitizer', () => {
  it('retains only the constrained composer surface', () => {
    const sanitized = withDOM((browser) => {
      const windowLike = browser as unknown as WindowLike
      return {
        allowed: sanitizeOutgoingHtml(
          '<p><strong>Safe</strong> <a href="https://attn.test">good</a></p>',
          windowLike
        ),
        script: sanitizeOutgoingHtml('<script>bad()</script><b>kept</b>', windowLike),
        unsafeLink: sanitizeOutgoingHtml('<a href="javascript:bad()">link</a>', windowLike),
        attributes: sanitizeOutgoingHtml('<p onclick="steal()" data-secret="x">copy</p>', windowLike)
      }
    })

    expect(sanitized.allowed).toContain('<strong>Safe</strong>')
    expect(sanitized.allowed).toContain('<a href="https://attn.test">good</a>')
    expect(sanitized.script).toBe('bad()<b>kept</b>')
    expect(sanitized.unsafeLink).toBe('link')
    expect(sanitized.attributes).toContain('copy')
    expect(Object.values(sanitized).join('')).not.toMatch(/<script|onclick|data-secret|javascript:/)
  })
})

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
