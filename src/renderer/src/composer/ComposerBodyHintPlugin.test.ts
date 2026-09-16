// @vitest-environment jsdom
import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { expect, it } from 'vitest'
import { $isAtAuthoredParagraphEnd } from './ComposerBodyHintPlugin'
import { AttnFooterNode } from './nodes/AttnFooterNode'

function atEnd(build: () => void): boolean {
  const editor = createHeadlessEditor({
    namespace: 'body-hint',
    nodes: [AttnFooterNode],
    onError: (error) => {
      throw error
    }
  })
  let result = false
  editor.update(
    () => {
      build()
      result = $isAtAuthoredParagraphEnd()
    },
    { discrete: true }
  )
  return result
}

it('allows an empty body and the end of text before the protected footer', () => {
  expect(
    atEnd(() => {
      const paragraph = $createParagraphNode()
      $getRoot().append(paragraph, new AttnFooterNode().append($createTextNode('Footer')))
      paragraph.selectEnd()
    })
  ).toBe(true)
  expect(
    atEnd(() => {
      const text = $createTextNode('Hello')
      $getRoot().append(
        $createParagraphNode().append(text),
        new AttnFooterNode().append($createTextNode('Footer'))
      )
      text.select(5, 5)
    })
  ).toBe(true)
})

it('rejects the middle of text, a range, and a caret inside the footer', () => {
  for (const [start, end] of [
    [0, 0],
    [2, 2],
    [0, 5]
  ]) {
    expect(
      atEnd(() => {
        const text = $createTextNode('Hello')
        $getRoot().append($createParagraphNode().append(text))
        text.select(start, end)
      })
    ).toBe(false)
  }
  expect(
    atEnd(() => {
      const footer = new AttnFooterNode().append($createTextNode('Footer'))
      $getRoot().append($createParagraphNode(), footer)
      footer.selectEnd()
    })
  ).toBe(false)
})

it('rejects later inline text but allows paragraph endings before later paragraphs', () => {
  expect(
    atEnd(() => {
      const text = $createTextNode('Hello')
      $getRoot().append($createParagraphNode().append(text, $createTextNode(' world').toggleFormat('bold')))
      text.select(5, 5)
    })
  ).toBe(false)
  for (const next of ['', 'Later paragraph']) {
    expect(
      atEnd(() => {
        const first = $createParagraphNode().append($createTextNode('Hello'))
        $getRoot().append(first, $createParagraphNode().append($createTextNode(next)))
        first.selectEnd()
      })
    ).toBe(true)
  }
})
