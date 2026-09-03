// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { findHtmlTrimStart } from './mailHtmlTrim'

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
