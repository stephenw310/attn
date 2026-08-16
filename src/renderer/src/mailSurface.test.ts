// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mailSurfaceForHtml } from './mailSurface'

describe('mail surface classification', () => {
  it('uses the native surface for plain and text-like HTML', () => {
    expect(mailSurfaceForHtml(null)).toBe('native')
    expect(mailSurfaceForHtml('<div>Pls see attached</div>')).toBe('native')
    expect(
      mailSurfaceForHtml('<p>Hello <strong>there</strong> <a href="https://attn.test">link</a></p>')
    ).toBe('native')
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
    expect(mailSurfaceForHtml('<style>.hero{color:red}</style><div class="hero">Designed mail</div>')).toBe(
      'light'
    )
  })
})
