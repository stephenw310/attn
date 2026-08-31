// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { containsRemoteMailContent } from './mailRemoteContent'

describe('containsRemoteMailContent', () => {
  it('detects the classic fetch attributes', () => {
    expect(containsRemoteMailContent('<img src="https://x.test/p.png">')).toBe(true)
    expect(containsRemoteMailContent('<img src=" http://x.test/p.png">')).toBe(true)
    expect(containsRemoteMailContent('<img srcset="a.png 1x, https://x.test/b.png 2x">')).toBe(true)
    expect(containsRemoteMailContent('<video poster="https://x.test/p.jpg"></video>')).toBe(true)
    expect(containsRemoteMailContent('<table background="https://x.test/bg.gif"></table>')).toBe(true)
  })

  it('detects SVG image references, which the sanitizer preserves via href', () => {
    expect(containsRemoteMailContent('<svg><image href="https://x.test/logo.svg" width="10"/></svg>')).toBe(
      true
    )
    expect(containsRemoteMailContent('<svg><image xlink:href="https://x.test/logo.svg"/></svg>')).toBe(true)
  })

  it('detects CSS-driven fetches in style attributes and stylesheets', () => {
    expect(containsRemoteMailContent('<div style="background-image:url(https://x.test/b.png)">x</div>')).toBe(
      true
    )
    expect(containsRemoteMailContent("<style>body{background:url('https://x.test/b.png')}</style>")).toBe(
      true
    )
    expect(containsRemoteMailContent('<style>@import "https://x.test/track.css";</style>')).toBe(true)
    expect(containsRemoteMailContent('<style>@import url(https://x.test/track.css);</style>')).toBe(true)
  })

  it('never fires on links, inline data, or URLs in plain text', () => {
    expect(containsRemoteMailContent('<a href="https://x.test/page">read online</a>')).toBe(false)
    expect(containsRemoteMailContent('<img src="cid:logo">')).toBe(false)
    expect(containsRemoteMailContent('<img src="data:image/gif;base64,R0l=">')).toBe(false)
    expect(containsRemoteMailContent('<p>see https://x.test/page for details</p>')).toBe(false)
    expect(containsRemoteMailContent('<style>body{color:#111}</style>')).toBe(false)
  })
})
