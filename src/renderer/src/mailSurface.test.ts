// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { normalizeAppleMailLineBackgrounds } from './mailAppleBackgrounds'
import {
  mailPresentationForHtml,
  mailSurfaceForHtml,
  normalizeNativeMailBackgrounds,
  normalizeNativeMailDocument
} from './mailSurface'

const APPLE_LINES =
  '<div style="-webkit-text-size-adjust:auto;background-color:rgb(58,58,60)"><span style="background-color:white">Hello <strong>there</strong>.</span></div>' +
  '<div style="-webkit-text-size-adjust:auto;background-color:rgb(58,58,60)"><span style="background-color:white"><br></span></div>' +
  '<div style="-webkit-text-size-adjust:auto;background-color:rgb(58,58,60)"><span style="background-color:white;color:#202124;font-size:17px">Thanks for your help.</span></div>'

describe('mail surface classification', () => {
  it.each([
    `<html class="apple-mail-supports-explicit-dark-mode"><body>${APPLE_LINES}</body></html>`,
    APPLE_LINES.replaceAll('-webkit-text-size-adjust', 'text-size-adjust'),
    `<div class="gmail_quote"><blockquote>${APPLE_LINES}</blockquote></div>`
  ])('uses native mail for repeated Apple Mail line backgrounds, including quotes', (html) => {
    expect(mailPresentationForHtml(html)).toEqual({ surface: 'native', layout: 'padded' })
  })

  it.each([
    APPLE_LINES.replaceAll('-webkit-text-size-adjust:auto;', ''),
    APPLE_LINES.replaceAll('rgb(58,58,60)', '#343b5c'),
    APPLE_LINES.replaceAll('background-color:white', 'background-color:yellow'),
    APPLE_LINES.replaceAll('-webkit-text-size-adjust:auto;', '-webkit-text-size-adjust:auto;padding:24px;'),
    `<table><tr><td>${APPLE_LINES}</td></tr></table>`,
    `<div style="background:#000">${APPLE_LINES}</div>`,
    `<style>div{border:1px solid red}</style>${APPLE_LINES}`,
    '<div style="-webkit-text-size-adjust:auto;background-color:rgb(58,58,60)"><span style="background-color:white">A single highlighted line.</span></div>'
  ])('keeps ambiguous or designed gray backgrounds intact', (html) => {
    expect(mailSurfaceForHtml(html)).toBe('light')
  })

  it('still preserves a designed panel beside Apple Mail lines', () => {
    expect(mailSurfaceForHtml(`${APPLE_LINES}<div style="background:#fff3d6">An important panel</div>`)).toBe(
      'light'
    )
  })

  it('cleans a sanitized display fragment without removing text, spacing, or designed siblings', () => {
    const template = document.createElement('template')
    template.innerHTML = `${APPLE_LINES}<div id="panel" style="background:#fff3d6">An important panel</div>`
    const text = template.content.textContent
    normalizeAppleMailLineBackgrounds(template.content)
    expect(template.content.textContent).toBe(text)
    expect(template.content.querySelectorAll('br')).toHaveLength(1)
    expect(template.content.querySelector('strong')?.textContent).toBe('there')
    const lines = [...template.content.querySelectorAll<HTMLElement>('div:not(#panel)')]
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => line.style.backgroundColor === '')).toBe(true)
    const spans = [...template.content.querySelectorAll<HTMLElement>('span')]
    expect(spans.every((span) => span.style.backgroundColor === '')).toBe(true)
    expect(spans[2].style.color).toBe('rgb(32, 33, 36)')
    expect(spans[2].style.fontSize).toBe('17px')
    expect(template.content.querySelector<HTMLElement>('#panel')?.style.backgroundColor).toBe(
      'rgb(255, 243, 214)'
    )
    const cleaned = template.innerHTML
    normalizeAppleMailLineBackgrounds(template.content)
    expect(template.innerHTML).toBe(cleaned)
  })

  it.each([
    APPLE_LINES.replaceAll('</span>', '<img src="logo.png"></span>'),
    APPLE_LINES.replaceAll('</span>', '<span style="background:yellow">Highlight</span></span>'),
    APPLE_LINES.replaceAll('</span>', '</span>More text'),
    APPLE_LINES.replaceAll('</span>', '<span style="padding:12px">Designed</span></span>')
  ])('does not normalize a line with additional design or uncovered text', (html) => {
    const template = document.createElement('template')
    template.innerHTML = html
    const before = template.innerHTML
    normalizeAppleMailLineBackgrounds(template.content)
    expect(template.innerHTML).toBe(before)
    expect(mailSurfaceForHtml(html)).toBe('light')
  })

  it('preserves white text backgrounds within a designed ancestor', () => {
    const template = document.createElement('template')
    template.innerHTML = `<div style="background:#000">${APPLE_LINES}</div>`
    const before = template.innerHTML
    normalizeAppleMailLineBackgrounds(template.content)
    expect(template.innerHTML).toBe(before)
  })

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

  it('does not confuse typography, media, or layout with an authored canvas', () => {
    const textLikeMessages = [
      '<font size="4" face="garamond, times new roman, serif">A formatted note</font>',
      '<img src="photo.jpg" width="640" height="480" alt="Trip photo">',
      '<picture><source srcset="photo.webp"><img src="photo.jpg" alt="Trip photo"></picture>',
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>',
      '<canvas width="300" height="150"></canvas><video></video><audio></audio>',
      '<center>Centered announcement</center>',
      '<table width="100%" align="left"><tr><td valign="top">Pasted totals</td></tr></table>',
      '<div style="display:block;max-width:640px;margin:0;padding:12px;border:1px solid #ddd">Exported note</div>',
      '<style>body{font-family:Arial;color:#1a1a1a;margin:28px auto;max-width:640px}.footer{border-top:1px solid #ddd}</style><p>Styled note</p>'
    ]

    for (const html of textLikeMessages) expect(mailSurfaceForHtml(html)).toBe('native')
  })

  it('keeps the real Garamond forward and its reply chain on the native surface', () => {
    const forwarded =
      '<div class="gmail_quote gmail_quote_container"><div class="gmail_attr">---------- Forwarded message ---------</div><div><font size="4" face="garamond, times new roman, serif">Thank you for praying for our Ethiopia mission.</font></div></div>'

    expect(mailSurfaceForHtml(`<div>draft a payer and share with them via text!!!</div>${forwarded}`)).toBe(
      'native'
    )
    expect(
      mailSurfaceForHtml(
        `<p>Yeah, let's do that.</p><blockquote><div>On Sunday, Ashley wrote:</div>${forwarded}</blockquote>`
      )
    ).toBe('native')
  })

  it('ignores presentation markup confined to a signature', () => {
    expect(
      mailSurfaceForHtml(
        '<div>Thanks</div><div class="gmail_signature"><table bgcolor="#f6d5c4"><tr><td><img src="logo.png">Logo</td></tr></table></div>'
      )
    ).toBe('native')
  })

  it('keeps a plain quoted reply trail on the native surface', () => {
    expect(
      mailSurfaceForHtml(
        '<div>Sounds good to me</div><blockquote type="cite"><table><tr><td><img src="photo.jpg">Are we still on for Tuesday?</td></tr></table></blockquote>'
      )
    ).toBe('native')
    expect(
      mailSurfaceForHtml(
        '<div>Sounds good</div><div class="gmail_quote"><style>.quote{margin:0;color:#111}</style><div class="quote">Original plain note</div></div>'
      )
    ).toBe('native')
  })

  it('uses a light document for non-neutral backgrounds and background images', () => {
    const designedMessages = [
      '<div style="background:#fff3d6">Designed mail</div>',
      '<table bgcolor="#f6d5c4"><tr><td>Summit agenda</td></tr></table>',
      '<table background="https://images.example/paper.png"><tr><td>Invitation</td></tr></table>',
      '<div style="background-image:linear-gradient(#fff,#dde8ff)">Designed mail</div>',
      '<style>.hero{background-color:#fff3d6}</style><div class="hero">Designed mail</div>',
      '<style>.hero{background:var(--hero-background)}</style><div class="hero">Designed mail</div>'
    ]

    for (const html of designedMessages) expect(mailSurfaceForHtml(html)).toBe('light')
  })

  it('keeps framed white transactional templates on their sender-owned light canvas', () => {
    const googleTransactional = `<table width="100%" bgcolor="#ffffff"><tr><td>
      <table bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;
        border-top:25px solid #e5e5e5;border-right:25px solid #e5e5e5;
        border-bottom:25px solid #e5e5e5;border-left:25px solid #e5e5e5">
        <tr><td style="color:#808080">Action required</td></tr>
      </table>
    </td></tr></table>`

    expect(mailSurfaceForHtml(googleTransactional)).toBe('light')
    expect(mailSurfaceForHtml('<div style="border:1px solid #ddd">Ordinary note</div>')).toBe('native')
    expect(mailSurfaceForHtml('<blockquote style="border-left:25px solid #ddd">Quote</blockquote>')).toBe(
      'native'
    )
  })

  it('ignores stylesheet background rules that cannot match the message', () => {
    expect(mailSurfaceForHtml('<style>.unused{background:#123456}</style><p>Hello</p>')).toBe('native')
    expect(
      mailSurfaceForHtml('<style>@media (max-width:600px){.unused{background:#123456}}</style><p>Hello</p>')
    ).toBe('native')
    expect(
      mailSurfaceForHtml('<style>[data-label="a,b"]{background:#123456}</style><p data-label="a,b">Hello</p>')
    ).toBe('light')
    expect(
      mailSurfaceForHtml('<style>.button:hover{background:#123456}</style><a class="button">Open</a>')
    ).toBe('light')
    expect(
      mailSurfaceForHtml('<style>p{background:#123456;background:transparent}</style><p>Hello</p>')
    ).toBe('native')
  })

  it('uses the winning stylesheet background after the author cascade', () => {
    const neutralMessages = [
      '<style>.card{background:#123456}.card{background:transparent}</style><div class="card">Plain</div>',
      '<style>div.card{background:transparent}.card{background:#123456}</style><div class="card">Plain</div>',
      '<style>.card{background:#123456}.card{background:transparent!important}</style><div class="card">Plain</div>',
      '<style>#message{background:transparent}.card{background:#123456}</style><div id="message" class="card">Plain</div>',
      '<style>.card{background:#123456}</style><div class="card" style="background:transparent">Plain</div>',
      '<style>.card{background:#123456}</style><style>.card{background:transparent}</style><div class="card">Plain</div>',
      '<style>.card{background:#123456!important}</style><div class="card" style="background:transparent!important">Plain</div>'
    ]
    for (const html of neutralMessages) expect(mailSurfaceForHtml(html)).toBe('native')

    const designedMessages = [
      '<style>.card{background:transparent}.card{background:#123456}</style><div class="card">Designed</div>',
      '<style>.card{background:#123456!important}.card{background:transparent}</style><div class="card">Designed</div>',
      '<style>div.card{background:#123456}.card{background:transparent}</style><div class="card">Designed</div>',
      '<style>.card{background:#123456!important}</style><div class="card" style="background:transparent">Designed</div>'
    ]
    for (const html of designedMessages) expect(mailSurfaceForHtml(html)).toBe('light')
  })

  it('accepts browser-valid important syntax on inline backgrounds', () => {
    expect(mailSurfaceForHtml('<div style="background:#123456 ! important">Designed mail</div>')).toBe(
      'light'
    )
    expect(
      mailSurfaceForHtml('<div style="background:#123456!important/* template note */">Designed mail</div>')
    ).toBe('light')
    expect(
      mailSurfaceForHtml('<div style="background:#fff ! important/* template note */">Plain mail</div>')
    ).toBe('native')
  })

  it('does not promote neutral background declarations to a light document', () => {
    const neutralMessages = [
      '<table bgcolor="white"><tr><td>Plain table</td></tr></table>',
      '<table bgcolor="FFFFFF"><tr><td>Plain table</td></tr></table>',
      '<div style="background:none;background-color:transparent">Plain note</div>',
      '<div style="background-image:none;background-color:rgba(12,34,56,0)">Plain note</div>',
      '<div style="background-color:white;background-image:initial">Plain note</div>',
      '<div style="background-color:rgb(255 255 255 / 1)">Plain note</div>',
      '<style>body{background:#fff!important;color:#333;margin:0}</style><p>Plain note</p>',
      '<style>#styled-white{background:#fff!important;font-weight:700}</style><div>Practice is at 5:00.</div><p><span id=inline-white style="background:#fff;color:#202124">Bring a glove and water.</span></p><p id=styled-white>Games start next Saturday.</p>'
    ]

    for (const html of neutralMessages) expect(mailSurfaceForHtml(html)).toBe('native')
  })

  it('ignores canvases that exist only in a dark color-scheme media query', () => {
    expect(
      mailSurfaceForHtml(
        '<style>@media screen and (prefers-color-scheme:dark){body{background:#111}}body{color:#222}</style><p>Dark-capable note</p>'
      )
    ).toBe('native')
    expect(
      mailSurfaceForHtml(
        '<style>@media (prefers-color-scheme:light){body{background:#fff3d6}}</style><p>Designed note</p>'
      )
    ).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<style>@media (prefers-color-scheme:dark), (max-width:600px){body{background:#fff3d6}}</style><p>Responsive design</p>'
      )
    ).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<style>@media not (prefers-color-scheme:dark){body{background:#fff3d6}}</style><p>Light-only design</p>'
      )
    ).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<style>@media not screen and (prefers-color-scheme:dark){body{background:#fff3d6}}</style><p>Negated dark design</p>'
      )
    ).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<style>@media not screen and (prefers-color-scheme:light){body{background:#fff3d6}}</style><p>Negated light design</p>'
      )
    ).toBe('native')
  })

  it('ignores print-only backgrounds when resolving the screen canvas', () => {
    expect(
      mailSurfaceForHtml(
        '<style>@media print{.receipt{background:#123456}}</style><p class="receipt">Receipt</p>'
      )
    ).toBe('native')

    expect(
      mailSurfaceForHtml(
        '<style>body{background:#fff}@media print{#receipt{background:#fff!important}#summary{background:#fff!important;color:#000!important}table{background:#fff!important}}</style><div style="display:none">Preview</div><table id="receipt" width="100%" bgcolor="#ecf0f1"><tr><td id="summary" style="background:#2c3d4f;color:#fff">Confirmed order</td></tr></table>'
      )
    ).toBe('light')

    expect(
      mailSurfaceForHtml(
        '<style>@media print, screen and (prefers-color-scheme:dark){body{background:#111}}</style><p>Screen note</p>'
      )
    ).toBe('native')
  })

  it('preserves a real authored canvas inside forwarded content', () => {
    const forwarded =
      '<div class="gmail_quote"><table bgcolor="#f6d5c4"><tr><td>Summit agenda</td></tr></table></div>'
    expect(mailSurfaceForHtml(`<div>---------- Forwarded message ----------</div>${forwarded}`)).toBe('light')
    expect(mailSurfaceForHtml(`<div>FYI</div>${forwarded}`)).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<div class="gmail_quote"><style>.hero{background:#fff3d6}</style><div class="hero">Designed</div></div>'
      )
    ).toBe('light')
    expect(
      mailSurfaceForHtml(
        '<style>.gmail_quote{background:#f6d5c4}</style><div class="gmail_quote">Quoted design</div>'
      )
    ).toBe('light')
  })

  it('keeps native mail and constrained canvases padded', () => {
    const nativeFragments = [
      '<table><tr><td>Compact data</td></tr></table>',
      '<img src="https://images.example/chart.png" alt="Chart">',
      '<div style="max-width:600px">Designed fragment</div>',
      '<style>.canvas{background:#eef2ff}.canvas{background:transparent}</style><div class="canvas">Text</div>',
      '<style>.canvas{background:#eef2ff}</style><div class="canvas" style="background:transparent">Text</div>',
      '<style>.canvas{background:transparent}</style><div class="canvas" bgcolor="#eef2ff">Text</div>'
    ]
    for (const html of nativeFragments) {
      expect(mailPresentationForHtml(html)).toEqual({ surface: 'native', layout: 'padded' })
    }

    const paddedCanvases = [
      '<table bgcolor="#eef2ff"><tr><td>Small card</td></tr></table>',
      '<div style="max-width:600px;background:#eef2ff">Centered card</div>',
      'Intro text<div style="background:#eef2ff">Colored section</div>',
      '<html style="background:#eef2ff"><body><table><tr><td>HTML wrapper canvas</td></tr></table></body></html>',
      '<body bgcolor="#eef2ff"><table><tr><td>Body wrapper canvas</td></tr></table></body>'
    ]
    for (const html of paddedCanvases) {
      expect(mailPresentationForHtml(html)).toEqual({ surface: 'light', layout: 'padded' })
    }

    const centeredCanvases = [
      '<div style="width:600px;background:#eef2ff">Fixed-width card</div>',
      '<table width="600" bgcolor="#eef2ff"><tr><td>Fixed-width table</td></tr></table>',
      '<style>.card{width:40em}</style><div class="card" style="background:#eef2ff">Styled card</div>'
    ]
    for (const html of centeredCanvases) {
      expect(mailPresentationForHtml(html)).toEqual({ surface: 'light', layout: 'centered' })
    }
  })

  it('uses full bleed only when the winning background owns the outer canvas', () => {
    const fullBleedMessages = [
      '<table width="100%" bgcolor="#eef2ff"><tr><td>Newsletter</td></tr></table>',
      '<table width="100%"><tr><td bgcolor="#eef2ff">Newsletter cell</td></tr></table>',
      '<table width="600" style="width:100%;background:#eef2ff"><tr><td>Responsive newsletter</td></tr></table>',
      '<div style="background:#eef2ff">Block canvas</div>',
      '<style>body{background:#eef2ff}.canvas{background:#dbeafe}</style><div>Body canvas</div>',
      '<style>.canvas{background:#dbeafe}</style><div class="canvas">Styled canvas</div>'
    ]
    for (const html of fullBleedMessages) {
      expect(mailPresentationForHtml(html)).toEqual({ surface: 'light', layout: 'full-bleed' })
    }

    expect(
      mailPresentationForHtml(
        '<style>.canvas{background:#dbeafe}.canvas{background:transparent}</style><div class="canvas">No canvas</div>'
      )
    ).toEqual({ surface: 'native', layout: 'padded' })
  })

  it('removes sender canvases while adapting meaningful text colors for the native surface', () => {
    const document = new DOMParser().parseFromString(
      '<style>div{background:white}</style><div bgcolor="white" background="paper.png" style="background:url(data:image/gif;base64,AAA);color:#111;margin:0"><span style="font-size:12px;background-image:none">Question</span><font id="legacy-blue" color="#0056d6">Answer</font><span id="inline-blue" style="color:#0042a9">More</span></div>',
      'text/html'
    )

    normalizeNativeMailDocument(document)

    expect(document.querySelector('style')).toBeNull()
    expect(document.body.innerHTML).not.toContain('background')
    expect(document.body.innerHTML).not.toContain('bgcolor')
    expect(document.querySelector('div')?.style.color).toBe('')
    expect(document.body.innerHTML).toMatch(/margin:\s*0/)
    expect(document.body.innerHTML).toMatch(/font-size:\s*12px/)
    const legacyBlue = document.querySelector<HTMLElement>('#legacy-blue')
    const inlineBlue = document.querySelector<HTMLElement>('#inline-blue')
    expect(legacyBlue?.hasAttribute('color')).toBe(false)
    expect(legacyBlue?.style.color).toMatch(/^rgb\(/)
    expect(inlineBlue?.style.color).toMatch(/^rgb\(/)
    expect(legacyBlue?.style.color).not.toBe(inlineBlue?.style.color)
  })

  it('removes inline native backgrounds without changing light-theme foreground styles', () => {
    const document = new DOMParser().parseFromString(
      '<style>.copy{font-family:serif;background:#fff}</style><div id="copy" bgcolor="white" style="color:#123456;background:white;font-size:16px">Question</div>',
      'text/html'
    )

    normalizeNativeMailBackgrounds(document)

    const copy = document.querySelector<HTMLElement>('#copy')
    expect(document.querySelector('style')?.textContent).toContain('font-family:serif')
    expect(copy?.hasAttribute('bgcolor')).toBe(false)
    expect(copy?.style.background).toBe('')
    expect(copy?.style.color).toBe('rgb(18, 52, 86)')
    expect(copy?.style.fontSize).toBe('16px')
  })
})
