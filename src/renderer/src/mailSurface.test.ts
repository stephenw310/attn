// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mailSurfaceForHtml, normalizeNativeMailDocument } from './mailSurface'

describe('mail surface classification', () => {
  it('uses the native surface for plain and text-like HTML', () => {
    expect(mailSurfaceForHtml(null)).toBe('native')
    expect(mailSurfaceForHtml('<div>Pls see attached</div>')).toBe('native')
    expect(
      mailSurfaceForHtml('<p>Hello <strong>there</strong> <a href="https://attn.test">link</a></p>')
    ).toBe('native')
    expect(mailSurfaceForHtml('<div dir="ltr"><span style="font-size:12.8px">Gmail text</span></div>')).toBe(
      'native'
    )
    expect(mailSurfaceForHtml('<div style="background-color:rgb(255, 255, 255)">Plain mail</div>')).toBe(
      'native'
    )
  })

  it('ignores rich markup confined to a signature or quoted trail', () => {
    expect(
      mailSurfaceForHtml(
        '<div>Thanks</div><div class="gmail_signature"><table><tr><td>Logo</td></tr></table></div>'
      )
    ).toBe('native')
  })

  it('keeps authored presentation HTML on a light document surface', () => {
    expect(mailSurfaceForHtml('<table><tr><td>Newsletter</td></tr></table>')).toBe('light')
    expect(mailSurfaceForHtml('<div style="max-width:600px">Designed mail</div>')).toBe('light')
    expect(mailSurfaceForHtml('<div style="background:#fff3d6">Designed mail</div>')).toBe('light')
    expect(mailSurfaceForHtml('<style>.hero{color:red}</style><div class="hero">Designed mail</div>')).toBe(
      'light'
    )
  })

  it('removes sender canvases but preserves typography on the native surface', () => {
    const document = new DOMParser().parseFromString(
      '<style>div{background:white}</style><div style="background:#fff;color:#111"><span style="font-size:12px;background-image:none">Text</span></div>',
      'text/html'
    )

    normalizeNativeMailDocument(document)

    expect(document.querySelector('style')).toBeNull()
    expect(document.body.innerHTML).not.toContain('background')
    expect(document.body.innerHTML).toMatch(/color:\s*#111/)
    expect(document.body.innerHTML).toMatch(/font-size:\s*12px/)
  })
})
