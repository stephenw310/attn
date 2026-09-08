// @vitest-environment jsdom

import createDOMPurify from 'dompurify'
import { describe, expect, it } from 'vitest'
import { sanitizeMailHtml, sanitizeQuotedMailHtml, stripUnsafeQuoteCss } from './mailSanitizer'

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
  // The real cases live in `e2e/mail-fonts.spec.ts`, where a Chromium parser
  // decides what an at-rule is. Nothing short of that parser agrees with it,
  // which is the whole reason this does not try to read the sheet itself.
  it('leaves a sheet that declares no at-rule alone', () => {
    const sanitized = sanitizeMailHtml(createDOMPurify(window), '<style>p{color:red}</style><p>hi</p>')
    expect(sanitized).toContain('p{color:red}')
  })

  it('deletes the face and keeps the rest of the sheet', () => {
    // jsdom's parser is not Chromium's, so this pins the contract and no more:
    // which sheets survive a hostile at-rule is settled in the e2e cases, where
    // the parser that decides is the one that will render the mail.
    const html = '<style>@font-face{font-family:Sender;src:url(x)}p{color:red}</style><p>hi</p>'
    const sanitized = sanitizeMailHtml(createDOMPurify(window), html)
    expect(sanitized).not.toContain('font-face')
    expect(sanitized).toContain('color: red')
    expect(sanitized).toContain('<p>hi</p>')
  })
})
