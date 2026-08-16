// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeDraftHtmlForImport, sanitizeOutgoingHtml } from './sanitize'

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
      gmailSignatureClassOnly: sanitizeOutgoingHtml(
        '<div class="gmail_signature"><span>Class marker</span></div>'
      ),
      gmailSignatureDataOnly: sanitizeOutgoingHtml(
        '<div data-smartmail="gmail_signature"><span>Data marker</span></div>'
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
    expect(sanitized.gmailSignatureClassOnly).toBe(
      '<div class="gmail_signature"><span>Class marker</span></div>'
    )
    expect(sanitized.gmailSignatureDataOnly).toBe(
      '<div data-smartmail="gmail_signature"><span>Data marker</span></div>'
    )
    expect(sanitized.fakeSignature).toBe('<div>Fake</div>')
    expect(Object.values(sanitized).join('')).not.toMatch(/<script|onclick|data-secret|javascript:/)
  })

  it('keeps supported numeric formatting attributes without widening URI schemes', () => {
    const html =
      '<img src="cid:a@b" alt="x" width="120" height="80"><table><tbody><tr><td colspan="2" rowspan="3">Cell</td></tr></tbody></table><ol start="4"><li>Fourth</li></ol><a href="javascript:bad()">bad</a>'

    for (const sanitized of [sanitizeDraftHtmlForImport(html), sanitizeOutgoingHtml(html)]) {
      expect(sanitized).toContain('width="120"')
      expect(sanitized).toContain('height="80"')
      expect(sanitized).toContain('colspan="2"')
      expect(sanitized).toContain('rowspan="3"')
      expect(sanitized).toContain('start="4"')
      expect(sanitized).not.toContain('javascript:')
    }
  })

  it('keeps safe authored backgrounds and drops backgrounds that load resources', () => {
    expect(
      sanitizeOutgoingHtml('<table style="background:#fff3d6"><tr><td>Newsletter</td></tr></table>')
    ).toContain('style="background:#fff3d6"')
    expect(
      sanitizeOutgoingHtml(
        '<table style="background:url(https://tracker.test/pixel.gif) #fff"><tr><td>Tracked</td></tr></table>'
      )
    ).not.toContain('style=')
  })
})
