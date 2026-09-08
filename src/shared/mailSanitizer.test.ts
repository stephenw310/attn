// @vitest-environment jsdom

import createDOMPurify from 'dompurify'
import { describe, expect, it } from 'vitest'
import {
  sanitizeMailHtml,
  sanitizeQuotedMailHtml,
  stripFontFaceRules,
  stripUnsafeQuoteCss
} from './mailSanitizer'

describe('stripUnsafeQuoteCss', () => {
  it('removes the properties that lift quoted content out of normal flow', () => {
    expect(stripUnsafeQuoteCss('position:fixed;inset:0;background:white;z-index:9999')).toBe(
      'background:white'
    )
    expect(stripUnsafeQuoteCss('position:absolute;top:0;left:0;width:100%;height:100%')).toBe(
      'width:100%; height:100%'
    )
    expect(stripUnsafeQuoteCss('transform:translateY(-900px);color:red')).toBe('color:red')
    expect(
      stripUnsafeQuoteCss(
        'translate:0 -900px;rotate:45deg;scale:20;offset-path:path("M 0 -900");text-indent:-900px;color:red'
      )
    ).toBe('color:red')
  })

  it('keeps the formatting that makes a quote readable', () => {
    const formatting =
      'color:#333; font-weight:bold; font-family:"Helvetica Neue", Arial; border-left:2px solid #ccc; padding:8px'
    expect(stripUnsafeQuoteCss(formatting)).toBe(formatting)
  })

  it('drops negative margins by value while keeping positive ones', () => {
    expect(stripUnsafeQuoteCss('margin-top:-500px;color:blue')).toBe('color:blue')
    expect(stripUnsafeQuoteCss('margin:0 -40px')).toBe('')
    expect(stripUnsafeQuoteCss('margin:0 auto;margin-bottom:12px')).toBe('margin:0 auto; margin-bottom:12px')
  })

  it('sees a negative length behind a calc operator', () => {
    expect(stripUnsafeQuoteCss('margin-top:calc(600px*-1);color:blue')).toBe('color:blue')
    expect(stripUnsafeQuoteCss('margin-left:calc(1px/-0.01);color:blue')).toBe('color:blue')
    expect(stripUnsafeQuoteCss('margin-top:calc(8px*2)')).toBe('margin-top:calc(8px*2)')
  })

  it('drops declarations that consume custom properties', () => {
    expect(stripUnsafeQuoteCss('--m:-600px;margin:var(--m);color:var(--ink, red);padding:8px')).toBe(
      '--m:-600px; padding:8px'
    )
    expect(stripUnsafeQuoteCss('margin:calc(8px + VAR(--m));border-left:2px solid #ccc')).toBe(
      'border-left:2px solid #ccc'
    )
  })

  it('drops CSS escapes before browsers can decode blocked identifiers', () => {
    expect(
      stripUnsafeQuoteCss('tr\\61nslate:0 -900px;margin-top:v\\61r(--m);text\\2d indent:-900px;color:red')
    ).toBe('color:red')
  })

  it('matches vendor-prefixed forms of the same properties', () => {
    expect(stripUnsafeQuoteCss('-webkit-transform:scale(50);color:red')).toBe('color:red')
  })

  it('splits on top-level semicolons only, so values keep their own', () => {
    expect(stripUnsafeQuoteCss('background:url(data:image/gif;base64,AAA);position:fixed')).toBe(
      'background:url(data:image/gif;base64,AAA)'
    )
    expect(stripUnsafeQuoteCss('font-family:"a;b";position:fixed')).toBe('font-family:"a;b"')
  })

  it('drops the legacy CSS scripting vectors', () => {
    expect(stripUnsafeQuoteCss('behavior:url(x.htc);-moz-binding:url(y.xml);color:red')).toBe('color:red')
    expect(stripUnsafeQuoteCss('width:expression(alert(1));color:red')).toBe('color:red')
  })

  it('discards malformed fragments rather than passing them through', () => {
    expect(stripUnsafeQuoteCss('position:fixed')).toBe('')
    expect(stripUnsafeQuoteCss('not-a-declaration;;color:red')).toBe('color:red')
    expect(stripUnsafeQuoteCss('')).toBe('')
  })
})

describe('mail sanitizer policies', () => {
  it('opens every displayed mail link in the browser, whoever calls it first', () => {
    // The hook belongs to the display policy, not to whichever renderer module
    // happened to evaluate first and register it on the shared purifier.
    const purifier = createDOMPurify(window)
    const clean = sanitizeMailHtml(purifier, '<a href="https://example.com">Read</a>')

    expect(clean).toContain('target="_blank"')
    expect(clean).toContain('rel="noopener noreferrer"')
  })

  it('leaves quoted mail links untouched by the display link hook', () => {
    const purifier = createDOMPurify(window)
    sanitizeMailHtml(purifier, '<a href="https://example.com">Read</a>')
    const quoted = sanitizeQuotedMailHtml(purifier, '<a href="https://example.com">Read</a>')

    expect(quoted).not.toContain('rel="noopener noreferrer"')
  })

  it('strips inline event handlers from displayed and quoted mail', () => {
    const purifier = createDOMPurify(window)
    const html = '<p onclick="steal()" onerror="x()" onmouseover="y()">Hi</p>'

    expect(sanitizeMailHtml(purifier, html)).toBe('<p>Hi</p>')
    expect(sanitizeQuotedMailHtml(purifier, html)).toBe('<p>Hi</p>')
  })

  it('refuses a sender claim on the private markers', () => {
    const purifier = createDOMPurify(window)
    const clean = sanitizeMailHtml(
      purifier,
      '<div data-attn-trim-start="1" data-attn-cid-source="x" data-attn-image-pending="1">Hi</div>'
    )

    expect(clean).toBe('<div>Hi</div>')
  })
})

describe('sender font faces', () => {
  it('drops an @font-face and keeps the rest of the sheet', () => {
    expect(
      stripFontFaceRules(
        'p{color:red}@font-face{font-family:X;src:url(data:font/woff2;base64,AA)}b{color:blue}'
      )
    ).toBe('p{color:red}b{color:blue}')
  })

  it('reads the at-rule name through CSS escapes', () => {
    // `@\66 ont-face` is the same at-rule to a parser, so a plain string match
    // would walk straight past it.
    expect(stripFontFaceRules('@\\66 ont-face{src:url(x)}p{color:red}')).toBe('p{color:red}')
    expect(stripFontFaceRules('@\\46\\4F\\4Et-face{src:url(x)}p{color:red}')).toBe('p{color:red}')
  })

  it('keeps at-rules a sender may legitimately use, including nested ones', () => {
    expect(stripFontFaceRules('@media print{p{color:red}}')).toBe('@media print{p{color:red}}')
    expect(stripFontFaceRules('@media print{@font-face{src:url(x)}p{color:red}}')).toBe(
      '@media print{p{color:red}}'
    )
  })

  it('drops an unterminated rule rather than leaving it open', () => {
    expect(stripFontFaceRules('p{color:red}@font-face{src:url(x)')).toBe('p{color:red}')
  })

  it('strips the rule out of a sanitized style element', () => {
    const html =
      '<style>@font-face{font-family:Sender;src:url(data:font/woff2;base64,AA)}p{color:red}</style><p>hi</p>'
    const sanitized = sanitizeMailHtml(createDOMPurify(window), html)
    expect(sanitized).not.toContain('font-face')
    expect(sanitized).toContain('color:red')
  })
})
