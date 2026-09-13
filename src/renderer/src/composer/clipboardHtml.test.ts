// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeClipboardHtml } from './clipboardHtml'
import { prepareHtmlForEditor } from './preserve'

const notesHtml = readFileSync('e2e/fixtures/notes-clipboard.html.txt', 'utf8')

function cocoa(styles: string, body: string): string {
  return `<meta name="Generator" content="Cocoa HTML Writer"><style>${styles}</style>${body}`
}

describe('Cocoa clipboard text', () => {
  it('keeps exported Notes paragraphs editable with blank lines and typography', () => {
    const prepared = prepareHtmlForEditor(normalizeClipboardHtml(notesHtml))
    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    const doc = new DOMParser().parseFromString(prepared.html, 'text/html')
    expect(doc.querySelectorAll('p')).toHaveLength(7)
    expect(doc.querySelectorAll('br')).toHaveLength(4)
    expect(doc.querySelector('span')?.getAttribute('style')).toContain('Helvetica Neue')
    expect(doc.querySelector('span')?.getAttribute('style')).toContain('13px')
  })

  it('preserves emphasis, links, class cascade order, and inline overrides', () => {
    const html = cocoa(
      'p.p1 {font: bold 13px Helvetica; color: red} p.p1 {color: blue} span.s1 {font-style: italic}',
      '<p class="p1"><span class="s1">Hello</span> <a href="https://example.com">link</a></p><p class="p1" style="color: green">Override</p>'
    )
    const prepared = prepareHtmlForEditor(normalizeClipboardHtml(html))
    expect(prepared.issues).toEqual([])
    expect(prepared.html).toContain('font-weight: bold')
    expect(prepared.html).toContain('font-style: italic')
    expect(prepared.html).toContain('color: blue')
    expect(prepared.html).toContain('color: green')
    expect(prepared.html).toContain('href="https://example.com"')
  })

  it('keeps ordinary HTML and simplifies unsupported stylesheets', () => {
    const cases = [
      '<style>.hero {color:red}</style><p class="hero">Text</p>',
      cocoa('table {width:500px}', '<table><tr><td>Cell</td></tr></table>'),
      cocoa('@media print {p.p1 {color:red}}', '<p class="p1">Text</p>'),
      cocoa('p.p1 {min-height:100px}', '<p class="p1">Layout</p>'),
      cocoa('p.p1 {position:absolute}', '<p class="p1">Positioned</p>')
    ]
    for (const html of cases) expect(normalizeClipboardHtml(html)).not.toContain('<style')
  })

  it('still sanitizes untrusted content and preserves unsupported tables', () => {
    const html = cocoa(
      'p.p1 {background: url(https://example.com/image)}',
      '<p class="p1" onclick="alert(1)">Text<script>alert(1)</script></p><table cellpadding="8"><tr><td>Cell</td></tr></table>'
    )
    const prepared = prepareHtmlForEditor(normalizeClipboardHtml(html))
    expect(prepared.html).not.toContain('onclick')
    expect(prepared.html).not.toContain('script')
    expect(prepared.html).not.toContain('https://example.com/image')
    expect(prepared.html).toContain('data-attn-opaque')
  })
})

describe('shared clipboard normalization', () => {
  for (const source of ['docs', 'notion']) {
    it(`converts representative ${source} content without opaque regions`, () => {
      const html = readFileSync(`e2e/fixtures/${source}-clipboard.html.txt`, 'utf8')
      const prepared = prepareHtmlForEditor(normalizeClipboardHtml(html))
      expect(prepared.issues).toEqual([])
      expect(prepared.html).not.toContain('data-attn-opaque')
      expect(prepared.html).not.toContain('<iframe')
      expect(prepared.html).not.toContain('<input')
      if (source === 'docs') {
        expect(prepared.html).toContain('<table>')
        expect(prepared.html).toContain('start="3"')
        expect(prepared.html).not.toContain('docs-internal-guid')
      } else {
        expect(prepared.html).toContain('☑ Done')
        expect(prepared.html).toContain('☐ Next task')
        expect(prepared.html).toContain('Expanded text')
        expect(prepared.html).toContain('href="https://example.com/demo"')
      }
    })
  }
})

it('imports Cocoa list and table class names and sanitizes converted embed URLs', () => {
  const html = cocoa(
    'li.li1 {font: 13px Helvetica} ul.ul1 {list-style-type:disc} td.td1 {border-width:1px}',
    '<ul class="ul1"><li class="li1">Item</li></ul><table><tr><td class="td1">Cell</td></tr></table>'
  )
  expect(prepareHtmlForEditor(normalizeClipboardHtml(html)).issues).toEqual([])
  const unsafe = prepareHtmlForEditor(
    normalizeClipboardHtml(
      '<iframe src="javascript:alert(1)" title="Unsafe"></iframe><h2 onclick="alert(1)">Heading</h2>'
    )
  )
  expect(unsafe.html).not.toContain('javascript:')
  expect(unsafe.html).not.toContain('onclick')
  expect(unsafe.html).not.toContain('<iframe')
})

it('falls back to editable text for unsupported Cocoa list styles', () => {
  for (const marker of ['circle', 'square', 'decimal']) {
    const html = cocoa(`ul.ul1 {list-style-type:${marker}}`, '<ul class="ul1"><li>Item</li></ul>')
    expect(normalizeClipboardHtml(html)).toContain('Item')
    expect(prepareHtmlForEditor(normalizeClipboardHtml(html)).issues).toEqual([])
  }
})

it('uses clipboard plain text for unsupported CSS without interpreting markup', () => {
  const result = normalizeClipboardHtml(
    '<style>p::before{content:"generated"}</style><p>HTML</p>',
    '<b>literal</b>\nSecond line'
  )
  expect(result).toBe('<p>&lt;b&gt;literal&lt;/b&gt;<br>Second line</p>')
})

it('expands inline font shorthand while respecting later longhands', () => {
  const result = prepareHtmlForEditor(
    normalizeClipboardHtml('<p><span style="font:italic 16px Arial;font-size:18px">Sample</span></p>')
  )
  expect(result.issues).toEqual([])
  expect(result.html).toContain('font-family: Arial')
  expect(result.html).toContain('font-size: 18px')
  expect(result.html).toContain('font-style: italic')
})
