// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collapsedFindText, findTextRanges } from './readerFind'

function body(html: string): HTMLElement {
  const root = document.createElement('div')
  // Test-only markup, never message content.
  root.innerHTML = html
  return root
}

describe('reader find text ranges', () => {
  it('matches literal phrases across inline markup, case and whitespace differences', () => {
    const root = body('<p>Renewal <b>DEADLINE</b> today.</p><p>renewal\n deadline tomorrow</p>')
    expect(findTextRanges(root, 'renewal deadline').map((range) => range.toString())).toEqual([
      'Renewal DEADLINE',
      'renewal\n deadline'
    ])
  })
  it('keeps Unicode offsets and treats regex punctuation literally', () => {
    const root = body('<p>İ before 💌 [a.b] [axb] [A.B]</p>')
    expect(findTextRanges(root, '[a.b]').map((range) => range.toString())).toEqual(['[a.b]', '[A.B]'])
  })
  it('does not join separate paragraphs into a word or search controls and styles', () => {
    const root = body('<style>needle</style><button>needle</button><p>need</p><p>le</p><p>needle</p>')
    expect(findTextRanges(root, 'needle').map((range) => range.toString())).toEqual(['needle'])
    expect(findTextRanges(root, '   ')).toEqual([])
  })
  it('includes reader-hidden quoted text without mutating content', () => {
    const root = body('<div hidden>Quoted needle</div>')
    const before = root.innerHTML
    expect(findTextRanges(root, 'needle')).toHaveLength(1)
    expect(root.innerHTML).toBe(before)
  })
})

describe('collapsed find text', () => {
  it('extracts body text without mounting sender resources', () => {
    const html =
      '<style>p { background: url(https://example.test/bg.png) }</style><p>Find <b>this phrase</b></p><img src="cid:photo"><img src="https://example.test/image.png"><script>unsafe()</script>'
    const text = collapsedFindText(html, 'different fallback')
    expect(text.trim()).toBe('Find this phrase')
    expect(document.querySelector('img, script')).toBeNull()
    expect(collapsedFindText(null, 'Plain body')).toBe('Plain body')
  })
})
