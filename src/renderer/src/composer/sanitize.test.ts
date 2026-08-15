// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeOutgoingHtml } from './sanitize'

describe('outgoing HTML sanitizer in a browser-compatible DOM', () => {
  it('retains only the constrained composer surface', () => {
    const sanitized = {
      allowed: sanitizeOutgoingHtml('<p><strong>Safe</strong> <a href="https://attn.test">good</a></p>'),
      script: sanitizeOutgoingHtml('<script>bad()</script><b>kept</b>'),
      unsafeLink: sanitizeOutgoingHtml('<a href="javascript:bad()">link</a>'),
      attributes: sanitizeOutgoingHtml('<p onclick="steal()" data-secret="x">copy</p>')
    }

    expect(sanitized.allowed).toBe('<p><strong>Safe</strong> <a href="https://attn.test">good</a></p>')
    expect(sanitized.script).toBe('<b>kept</b>')
    expect(sanitized.unsafeLink).toBe('<a>link</a>')
    expect(sanitized.attributes).toBe('<p>copy</p>')
    expect(Object.values(sanitized).join('')).not.toMatch(/<script|onclick|data-secret|javascript:/)
  })
})
