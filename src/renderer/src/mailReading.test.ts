// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { findHtmlTrimStart, findTrimIndex, mailReadingForHtml } from './mailReading'

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

describe('findTrimIndex', () => {
  it('finds RFC signatures', () => {
    expect(findTrimIndex('Thanks for the update.\n-- \nMaya Lin')).toBe('Thanks for the update.'.length)
  })

  it('finds authored reply headers and trailing quote runs', () => {
    expect(findTrimIndex('Sounds good.\nOn Monday, Priya wrote:\n> Earlier note')).toBe(
      'Sounds good.\n'.length
    )
    expect(findTrimIndex('Current answer.\n> Old line one\n> Old line two')).toBe('Current answer.'.length)
  })

  it('uses the first marker when signature and quote are both present', () => {
    expect(findTrimIndex('Reply.\n-- \nMaya\nOn Tuesday, Daniel wrote:\n> Old')).toBe('Reply.'.length)
  })

  it('finds common mobile signatures', () => {
    expect(findTrimIndex('See you there.\nSent from my iPhone')).toBe('See you there.'.length)
    expect(findTrimIndex('Approved.\nSent from my Galaxy S25')).toBe('Approved.'.length)
  })

  it('finds decorated team signatures before trailing disclaimers', () => {
    const body =
      'We thank you for your trust and confidence.\n\n-- The Stokes Pharmacy Team --\nThis email may contain confidential information.'
    expect(findTrimIndex(body)).toBe('We thank you for your trust and confidence.\n'.length)
  })

  it('leaves normal text and mid-line delimiters untouched', () => {
    expect(findTrimIndex('No quoted content here.')).toBeNull()
    expect(findTrimIndex('Keep this -- text in the middle.')).toBeNull()
    expect(findTrimIndex('Treat the -- draft status -- as ordinary inline text.')).toBeNull()
    expect(findTrimIndex('Overview\n-- RELEASE NOTES --\nThe release includes three fixes.')).toBeNull()
    expect(findTrimIndex('> Quoted example\nAuthored text after it.')).toBeNull()
  })

  it('scans large mid-message quote runs in linear time', () => {
    const quoted = Array.from({ length: 2_000 }, (_, index) => `> Quoted line ${index}`).join('\n')
    expect(findTrimIndex(`Authored intro.\n${quoted}\nAuthored bottom reply.`)).toBeNull()
  })

  it('never collapses an all-quote message to nothing', () => {
    expect(findTrimIndex('> Entire message\n> Still quoted')).toBeNull()
    expect(findTrimIndex('On Monday, Maya wrote:\n> Entire message')).toBeNull()
  })
})

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

describe('findHtmlTrimStart', () => {
  it('reads a lone dash line as content inside verbatim text and table cells', () => {
    // A signature separator is a line the sender wrote to end the message. The
    // same two characters in a receipt cell or a code block are data, and
    // trimming there hides the rest of the mail behind the trim control.
    for (const html of [
      '<table><tbody><tr><td>--</td><td>No discount</td></tr><tr><td>Total</td><td>$10</td></tr></tbody></table>',
      '<table><tbody><tr><th>--</th><th>Column</th></tr></tbody></table>',
      '<pre>diff --git a/x b/x\n--\nstill the message</pre>',
      '<p><code>--</code> ends the options, and the rest of the mail follows.</p>'
    ]) {
      expect(findHtmlTrimStart(fragment(html))).toBeNull()
    }
  })

  it('still trims at an ordinary signature separator', () => {
    const content = fragment('<div>Answer</div><div>-- </div><div>Chao</div>')
    const boundary = findHtmlTrimStart(content)

    expect(boundary).not.toBeNull()
    expect((boundary as Element).textContent).toBe('-- ')
  })
})
