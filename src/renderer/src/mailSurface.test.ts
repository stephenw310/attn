// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mailPresentationForHtml, mailSurfaceForHtml, normalizeNativeMailDocument } from './mailSurface'

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

  it('ignores rich markup confined to a signature', () => {
    expect(
      mailSurfaceForHtml(
        '<div>Thanks</div><div class="gmail_signature"><table><tr><td>Logo</td></tr></table></div>'
      )
    ).toBe('native')
  })

  it('keeps a plain quoted reply trail on the native surface', () => {
    // The everyday reply. Quoting someone's plain text must not promote the
    // conversation to a document canvas.
    expect(
      mailSurfaceForHtml(
        '<div>Sounds good to me</div><blockquote type="cite"><div>Are we still on for Tuesday?</div></blockquote>'
      )
    ).toBe('native')
    expect(
      mailSurfaceForHtml(
        '<div>Sounds good</div><div class="gmail_quote"><div>Original plain note</div></div>'
      )
    ).toBe('native')
  })

  it('treats a forwarded document as content rather than decoration', () => {
    // A forward carries the whole message inside the quote, so ignoring it
    // renders a newsletter on the dark surface with its canvas stripped.
    const forwarded =
      '<div class="gmail_quote"><table bgcolor="#f6d5c4"><tr><td>Summit agenda</td></tr></table></div>'
    expect(mailSurfaceForHtml(`<div>---------- Forwarded message ----------</div>${forwarded}`)).toBe('light')
    expect(mailSurfaceForHtml(`<div>FYI</div>${forwarded}`)).toBe('light')
    expect(
      mailSurfaceForHtml(
        `<div class="gmail_quote"><style>.hero{color:red}</style><div class="hero">Designed</div></div>`
      )
    ).toBe('light')
  })

  it('does not let a signature inside a quoted trail promote the surface', () => {
    expect(
      mailSurfaceForHtml(
        '<div>Thanks</div><div class="gmail_quote"><div>Plain original</div><div class="gmail_signature"><table><tr><td>Logo</td></tr></table></div></div>'
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

  it('pads rich fragments that do not own the outer document canvas', () => {
    expect(mailPresentationForHtml('<table><tr><td>Compact data</td></tr></table>')).toEqual({
      surface: 'light',
      layout: 'padded'
    })
    expect(mailPresentationForHtml('<img src="https://images.example/chart.png" alt="Chart">')).toEqual({
      surface: 'light',
      layout: 'padded'
    })
    expect(mailPresentationForHtml('<div style="max-width:600px">Designed fragment</div>')).toEqual({
      surface: 'light',
      layout: 'padded'
    })
    expect(mailPresentationForHtml('<table bgcolor="#eef2ff"><tr><td>Small card</td></tr></table>')).toEqual({
      surface: 'light',
      layout: 'padded'
    })
    expect(
      mailPresentationForHtml('<div style="width:600px;background:#eef2ff">Fixed-width card</div>')
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml('<div style="max-width:600px;background:#eef2ff">Centered card</div>')
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml('Intro text<div style="background:#eef2ff">Colored section</div>')
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<style>@media (prefers-color-scheme: dark){body{background:#111}}</style><div>Text</div>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<style>.canvas{background:#eef2ff}.canvas{background:transparent}</style><div class="canvas">Text</div>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<style>.canvas{background:#eef2ff}</style><div class="canvas" style="background:transparent">Text</div>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<style>.canvas{background:transparent}</style><div class="canvas" bgcolor="#eef2ff">Text</div>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<html style="background:#eef2ff"><body><table><tr><td>HTML wrapper canvas</td></tr></table></body></html>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
    expect(
      mailPresentationForHtml(
        '<body bgcolor="#eef2ff"><table><tr><td>Body wrapper canvas</td></tr></table></body>'
      )
    ).toEqual({ surface: 'light', layout: 'padded' })
  })

  it('uses full bleed only when the message owns a non-neutral outer canvas', () => {
    expect(
      mailPresentationForHtml('<table width="100%" bgcolor="#eef2ff"><tr><td>Newsletter</td></tr></table>')
    ).toEqual({ surface: 'light', layout: 'full-bleed' })
    expect(
      mailPresentationForHtml(
        '<table width="100%"><tr><td bgcolor="#eef2ff">Newsletter cell</td></tr></table>'
      )
    ).toEqual({ surface: 'light', layout: 'full-bleed' })
    expect(
      mailPresentationForHtml(
        '<table width="600" style="width:100%;background:#eef2ff"><tr><td>Responsive newsletter</td></tr></table>'
      )
    ).toEqual({ surface: 'light', layout: 'full-bleed' })
    expect(mailPresentationForHtml('<div style="background:#eef2ff">Block canvas</div>')).toEqual({
      surface: 'light',
      layout: 'full-bleed'
    })
    expect(
      mailPresentationForHtml(
        '<style>body{background:#eef2ff}.canvas{background:#dbeafe}</style><div>Body canvas</div>'
      )
    ).toEqual({ surface: 'light', layout: 'full-bleed' })
    expect(
      mailPresentationForHtml(
        '<style>.canvas{background:#dbeafe}</style><div class="canvas">Styled canvas</div>'
      )
    ).toEqual({ surface: 'light', layout: 'full-bleed' })
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
