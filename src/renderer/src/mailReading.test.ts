// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mailReadingForHtml } from './mailReading'

const richQuote =
  '<div class="gmail_quote"><div>On Monday, Example wrote:</div>' +
  '<blockquote><table bgcolor="#e5edf8"><tr><td style="padding:24px">Older design</td></tr></table>' +
  '</blockquote></div>'

describe('reading a simple reply above rich history', () => {
  it('classifies authored content independently and preserves nested wrappers in both parts', () => {
    const html = `<div dir="ltr"><div style="font-size:16px"><div>Current answer</div>${richQuote}</div></div>`
    const reading = mailReadingForHtml(html)
    expect(reading.presentation).toEqual({ surface: 'native', layout: 'padded' })
    expect(reading.parts?.quotePresentation.surface).toBe('light')
    expect(reading.parts?.authoredHtml).toBe(
      '<div dir="ltr"><div style="font-size:16px"><div>Current answer</div></div></div>'
    )
    expect(reading.parts?.quoteHtml).toBe(
      `<div dir="ltr"><div style="font-size:16px">${richQuote.replace('<tr>', '<tbody><tr>').replace('</tr>', '</tr></tbody>')}</div></div>`
    )
    expect(reading.parts?.authoredText).toBe('Current answer')
    expect(reading.parts?.quoteText).toContain('Older design')
    expect(html).toContain('bgcolor="#e5edf8"')
  })

  it.each([
    '<div class="gmail_signature">Example signature</div>',
    '<div>-- </div><div>Example signature</div>',
    'Answer ends here\n-- \nExample signature'
  ])('keeps the signature in the collapsed tail: %s', (signature) => {
    const parts = mailReadingForHtml(`<div><div>Current answer</div>${signature}${richQuote}</div>`).parts
    expect(parts).toBeDefined()
    expect(parts?.authoredHtml).not.toContain('Example signature')
    expect(parts?.quoteHtml).toContain('Example signature')
    expect(parts?.quoteHtml).toContain('Older design')
  })

  it.each([
    richQuote,
    `<br> ${richQuote}`,
    `<div style="background:#ffdbac">Designed answer</div>${richQuote}`,
    `<style>div + .gmail_quote { margin-top:24px }</style><div>Answer</div>${richQuote}`,
    `<div style="display:flex"><div>Answer</div>${richQuote}</div>`,
    `<div style="padding:20px"><div>Answer</div>${richQuote}</div>`,
    `<div style="height:600px"><div>Answer</div>${richQuote}</div>`,
    `<table><tr><td>Answer${richQuote}</td></tr></table>`
  ])('keeps quote-only or layout-dependent mail in its original frame', (html) => {
    expect(mailReadingForHtml(html).parts).toBeUndefined()
  })

  it('keeps simple quotes on the native canvas without a second frame', () => {
    expect(mailReadingForHtml('<div>Answer</div><div class="gmail_quote">Earlier message</div>')).toEqual({
      presentation: { surface: 'native', layout: 'padded' }
    })
    expect(mailReadingForHtml(null).parts).toBeUndefined()
  })

  it('sanitizes before splitting and never uses script or forged marker content as fallback text', () => {
    const parts = mailReadingForHtml(
      `<div data-attn-trim-start="" onclick="alert(1)">Answer<script>secret script</script></div>${richQuote}`
    ).parts
    expect(parts).toBeDefined()
    expect(parts?.authoredHtml).toBe('<div>Answer</div>')
    expect(parts?.authoredText).toBe('Answer')
    expect(parts?.quoteHtml).not.toContain('data-attn-trim-start')
  })

  it('keeps line and table-cell boundaries readable in the oversized-document text fallback', () => {
    const parts = mailReadingForHtml(
      '<title>Hidden metadata</title><div>First line<br>Second line</div><div>Next paragraph</div>' +
        '<div class="gmail_quote"><table bgcolor="#e5edf8"><tr><td>Build</td><td>Ready</td></tr></table>' +
        '<p>Older paragraph</p></div>'
    ).parts
    expect(parts?.authoredText).toBe('First line\nSecond line\nNext paragraph')
    expect(parts?.quoteText).toBe('Build\tReady\t\nOlder paragraph')
  })
})
