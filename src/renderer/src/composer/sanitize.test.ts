// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizeDraftHtmlForImport, sanitizeOutgoingHtml } from './sanitize'

describe('outgoing HTML sanitizer in a browser-compatible DOM', () => {
  it('keeps only the native Gmail separator marker and strips active content', () => {
    const sanitized = sanitizeOutgoingHtml(
      '<span class="gmail_signature_prefix" onclick="steal()" data-smartmail="gmail_signature">-- </span>' +
        '<div class="gmail_signature_prefix">Wrong tag</div>' +
        '<span class="gmail_signature_prefix custom">Other class</span>'
    )
    const document = new DOMParser().parseFromString(sanitized, 'text/html')
    expect(document.querySelectorAll('[class]')).toHaveLength(1)
    expect(document.querySelector('.gmail_signature_prefix')?.outerHTML).toBe(
      '<span class="gmail_signature_prefix">-- </span>'
    )
    expect(sanitized).not.toMatch(/onclick|data-smartmail/)
  })

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

  it('strips inline event handlers on the import path too', () => {
    // DOMPurify's allowlist admits no `on*` attribute, so neither sanitizer
    // carries a handler list of its own; this is what pins that.
    const html = '<p onclick="steal()" onerror="x()" onmouseover="y()" onfocus="z()">Hi</p>'

    expect(sanitizeDraftHtmlForImport(html)).toBe('<p>Hi</p>')
    expect(sanitizeOutgoingHtml(html)).toBe('<p>Hi</p>')
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

  it('keeps legacy presentational table attributes, and only on table elements', () => {
    // SPEC §9 #18a: real mail paints tables with these, and ALLOWED_URI_REGEXP
    // was stripping them from every attribute value that is not a URI.
    const table =
      '<table border="1" cellpadding="4" cellspacing="0" bgcolor="#ffffff"><tbody><tr bgcolor="#eeeeee"><td align="center" valign="top">Cell</td></tr></tbody></table>'

    for (const sanitized of [sanitizeDraftHtmlForImport(table), sanitizeOutgoingHtml(table)]) {
      expect(sanitized).toContain('border="1"')
      expect(sanitized).toContain('cellpadding="4"')
      expect(sanitized).toContain('cellspacing="0"')
      expect(sanitized).toContain('bgcolor="#ffffff"')
      expect(sanitized).toContain('bgcolor="#eeeeee"')
      expect(sanitized).toContain('align="center"')
      expect(sanitized).toContain('valign="top"')
    }

    // Outside a table they stay dropped: `<div align>` remains an editable line
    // rather than becoming a frozen region (see the fidelity suite).
    const block = '<div align="center" bgcolor="#eeeeee">Centered</div>'
    for (const sanitized of [sanitizeDraftHtmlForImport(block), sanitizeOutgoingHtml(block)]) {
      expect(sanitized).toBe('<div>Centered</div>')
    }

    // Widening presentational names must not widen resource loading.
    expect(
      sanitizeOutgoingHtml('<table background="https://tracker.test/p.gif"><tr><td>x</td></tr></table>')
    ).not.toContain('tracker.test')
  })

  it('keeps legacy font typography without allowing handlers, resource styles, or attributes on other tags', () => {
    const html =
      '<font face="Arial, sans-serif" color="#123456" size="+2" dir="auto" onclick="steal()" style="background-image:url(https://tracker.test/pixel)">Type</font>' +
      '<span face="Arial" color="red" size="5">Plain</span><a href="javascript:steal()">Link</a>'
    for (const sanitized of [sanitizeDraftHtmlForImport(html), sanitizeOutgoingHtml(html)]) {
      const document = new DOMParser().parseFromString(sanitized, 'text/html')
      const font = document.querySelector('font')
      expect(font?.getAttribute('face')).toBe('Arial, sans-serif')
      expect(font?.getAttribute('color')).toBe('#123456')
      expect(font?.getAttribute('size')).toBe('+2')
      expect(font?.getAttribute('dir')).toBe('auto')
      expect(document.querySelector('span')?.attributes.length).toBe(0)
      expect(sanitized).not.toMatch(/onclick|javascript:|tracker\.test|background-image/)
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
    for (const value of [
      'image-set("https://tracker.test/a.png" 1x)',
      '-webkit-image-set("//tracker.test/a.png" 1x)',
      'cross-fade("https://tracker.test/a.png", #fff, 50%)',
      '-moz-element(#remote)',
      'paint(tracker)'
    ]) {
      expect(sanitizeOutgoingHtml(`<div style="background:${value}">Tracked</div>`)).not.toContain('style=')
    }
  })
})
