// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeOutgoingHtml } from './sanitize'

describe('outgoing HTML sanitizer in a browser-compatible DOM', () => {
  it('retains only the constrained composer surface', () => {
    const sanitized = {
      allowed: sanitizeOutgoingHtml('<p><strong>Safe</strong> <a href="https://attn.test">good</a></p>'),
      script: sanitizeOutgoingHtml('<script>bad()</script><b>kept</b>'),
      unsafeLink: sanitizeOutgoingHtml('<a href="javascript:bad()">link</a>'),
      attributes: sanitizeOutgoingHtml('<p onclick="steal()" data-secret="x">copy</p>'),
      gmailImage: sanitizeOutgoingHtml(
        '<img src="cid:ii_gmail" data-surl="cid:ii_gmail" data-secret="drop">'
      ),
      gmailSignature: sanitizeOutgoingHtml(
        '<div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr"><a href="https://attn.test" target="_blank">Safe</a></div>'
      ),
      fakeSignature: sanitizeOutgoingHtml(
        '<div class="not-gmail" data-smartmail="not-gmail" dir="sideways">Fake</div>'
      )
    }

    expect(sanitized.allowed).toBe('<p><strong>Safe</strong> <a href="https://attn.test">good</a></p>')
    expect(sanitized.script).toBe('<b>kept</b>')
    expect(sanitized.unsafeLink).toBe('<a>link</a>')
    expect(sanitized.attributes).toBe('<p>copy</p>')
    expect(sanitized.gmailImage).toBe('<img src="cid:ii_gmail" data-surl="cid:ii_gmail">')
    expect(sanitized.gmailSignature).toContain(
      '<div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr">'
    )
    expect(sanitized.gmailSignature).toContain('target="_blank"')
    expect(sanitized.fakeSignature).toBe('<div>Fake</div>')
    expect(Object.values(sanitized).join('')).not.toMatch(/<script|onclick|data-secret|javascript:/)
  })
})
