// @vitest-environment jsdom

import { createHeadlessEditor } from '@lexical/headless'
import { LinkNode } from '@lexical/link'
import { $createQuoteNode, QuoteNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  type LexicalEditor,
  type ParagraphNode
} from 'lexical'
import { describe, expect, it } from 'vitest'
import { AUTOCOMPLETE_MAX_PREFIX_CHARS, AUTOCOMPLETE_MAX_SUFFIX_CHARS } from '../../../shared/ai'
import type { AutocompleteExcerpt } from './autocompleteController'
import { $autocompleteExcerpt } from './autocompleteExcerpt'
import { AttnFooterNode } from './nodes/AttnFooterNode'
import { GmailSignatureNode } from './nodes/GmailSignatureNode'
import { GmailSignaturePrefixNode } from './nodes/GmailSignaturePrefixNode'

function editorWith(build: () => void): LexicalEditor {
  const editor = createHeadlessEditor({
    namespace: 'excerpt-test',
    nodes: [QuoteNode, LinkNode, GmailSignatureNode, GmailSignaturePrefixNode, AttnFooterNode],
    onError: (error) => {
      throw error
    }
  })
  editor.update(build, { discrete: true })
  return editor
}

function paragraph(text: string): ParagraphNode {
  const node = $createParagraphNode()
  if (text.length > 0) node.append($createTextNode(text))
  return node
}

function excerptOf(editor: LexicalEditor): AutocompleteExcerpt | null {
  let result: AutocompleteExcerpt | null = null
  editor.update(
    () => {
      result = $autocompleteExcerpt()
    },
    { discrete: true }
  )
  return result
}

describe('$autocompleteExcerpt', () => {
  it('splits the caret paragraph and joins neighbors with newlines', () => {
    const editor = editorWith(() => {
      const root = $getRoot()
      root.append(paragraph('First line.'))
      const middle = paragraph('Hello world')
      root.append(middle)
      root.append(paragraph('Last line.'))
      const text = middle.getFirstChild()
      if ($isTextNode(text)) text.select(9, 9)
    })
    const excerpt = excerptOf(editor)
    expect(excerpt?.prefix).toBe('First line.\nHello wor')
    expect(excerpt?.suffix).toBe('ld\nLast line.')
    expect(excerpt?.anchor).toBeTruthy()
  })

  it('excludes quotes, signatures, and the footer from extraction entirely', () => {
    const editor = editorWith(() => {
      const root = $getRoot()
      const quote = $createQuoteNode()
      quote.append($createTextNode('Quoted trail secret'))
      root.append(quote)
      const body = paragraph('My reply')
      root.append(body)
      const signature = new GmailSignatureNode()
      signature.append($createTextNode('Signature secret'))
      root.append(signature)
      const footer = new AttnFooterNode()
      footer.append($createTextNode('Sent with Attn'))
      root.append(footer)
      body.getFirstChild()?.selectEnd()
    })
    const excerpt = excerptOf(editor)
    expect(excerpt?.prefix).toBe('My reply')
    expect(excerpt?.suffix).toBe('')
    expect(excerpt?.prefix).not.toContain('secret')
  })

  it('a caret inside a protected region yields nothing', () => {
    for (const build of [
      () => {
        const quote = $createQuoteNode()
        const text = $createTextNode('Quoted')
        quote.append(text)
        $getRoot().append(quote)
        text.select(3, 3)
      },
      () => {
        const signature = new GmailSignatureNode()
        const text = $createTextNode('Sig')
        signature.append(text)
        $getRoot().append(signature)
        text.select(1, 1)
      },
      () => {
        const footer = new AttnFooterNode()
        const text = $createTextNode('Sent with Attn')
        footer.append(text)
        $getRoot().append(footer)
        text.select(2, 2)
      }
    ]) {
      expect(excerptOf(editorWith(build))).toBeNull()
    }
  })

  it('a non-collapsed selection yields nothing', () => {
    const editor = editorWith(() => {
      const body = paragraph('Hello world')
      $getRoot().append(body)
      const text = body.getFirstChild()
      if ($isTextNode(text)) text.select(0, 5)
    })
    expect(excerptOf(editor)).toBeNull()
  })

  it('supports the empty-paragraph caret after a text paragraph', () => {
    const editor = editorWith(() => {
      const root = $getRoot()
      root.append(paragraph('Above.'))
      const empty = paragraph('')
      root.append(empty)
      empty.select(0, 0)
    })
    const excerpt = excerptOf(editor)
    expect(excerpt?.prefix).toBe('Above.\n')
    expect(excerpt?.suffix).toBe('')
  })

  it('truncates away from the caret: prefix tail, suffix head', () => {
    const editor = editorWith(() => {
      const body = paragraph(`${'a'.repeat(3_000)}CARET${'b'.repeat(1_000)}`)
      $getRoot().append(body)
      const text = body.getFirstChild()
      if ($isTextNode(text)) text.select(3_005, 3_005)
    })
    const excerpt = excerptOf(editor)
    expect(excerpt?.prefix).toHaveLength(AUTOCOMPLETE_MAX_PREFIX_CHARS)
    expect(excerpt?.prefix.endsWith('CARET')).toBe(true)
    expect(excerpt?.suffix).toHaveLength(AUTOCOMPLETE_MAX_SUFFIX_CHARS)
    expect(excerpt?.suffix.startsWith('b')).toBe(true)
  })
})
