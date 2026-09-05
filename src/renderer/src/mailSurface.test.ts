// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { normalizeAppleMailLineBackgrounds } from './mailAppleBackgrounds'
import {
  forceLightMailCss,
  mailPresentationForHtml,
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
    expect(mailPresentationForHtml(html).surface).toBe('light')
  })

  it('still preserves a designed panel beside Apple Mail lines', () => {
    expect(
      mailPresentationForHtml(`${APPLE_LINES}<div style="background:#fff3d6">An important panel</div>`)
        .surface
    ).toBe('light')
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
    expect(mailPresentationForHtml(html).surface).toBe('light')
  })

  it('preserves white text backgrounds within a designed ancestor', () => {
    const template = document.createElement('template')
    template.innerHTML = `<div style="background:#000">${APPLE_LINES}</div>`
    const before = template.innerHTML
    normalizeAppleMailLineBackgrounds(template.content)
    expect(template.innerHTML).toBe(before)
  })

  it('uses the native surface for plain and text-like HTML', () => {
    expect(mailPresentationForHtml(null).surface).toBe('native')
    expect(mailPresentationForHtml('<div>Pls see attached</div>').surface).toBe('native')
    expect(
      mailPresentationForHtml('<p>Hello <strong>there</strong> <a href="https://attn.test">link</a></p>')
        .surface
    ).toBe('native')
    expect(
      mailPresentationForHtml('<div dir="ltr"><span style="font-size:12.8px">Gmail text</span></div>').surface
    ).toBe('native')
    expect(
      mailPresentationForHtml('<div style="background-color:rgb(255, 255, 255)">Plain mail</div>').surface
    ).toBe('native')
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

    for (const html of textLikeMessages) expect(mailPresentationForHtml(html).surface).toBe('native')
  })

  it('keeps the real Garamond forward and its reply chain on the native surface', () => {
    const forwarded =
      '<div class="gmail_quote gmail_quote_container"><div class="gmail_attr">---------- Forwarded message ---------</div><div><font size="4" face="garamond, times new roman, serif">Thank you for praying for our Ethiopia mission.</font></div></div>'

    expect(
      mailPresentationForHtml(`<div>draft a payer and share with them via text!!!</div>${forwarded}`).surface
    ).toBe('native')
    expect(
      mailPresentationForHtml(
        `<p>Yeah, let's do that.</p><blockquote><div>On Sunday, Ashley wrote:</div>${forwarded}</blockquote>`
      ).surface
    ).toBe('native')
  })

  it('ignores presentation markup confined to a signature', () => {
    expect(
      mailPresentationForHtml(
        '<div>Thanks</div><div class="gmail_signature"><table bgcolor="#f6d5c4"><tr><td><img src="logo.png">Logo</td></tr></table></div>'
      ).surface
    ).toBe('native')
  })

  it('keeps a plain quoted reply trail on the native surface', () => {
    expect(
      mailPresentationForHtml(
        '<div>Sounds good to me</div><blockquote type="cite"><table><tr><td><img src="photo.jpg">Are we still on for Tuesday?</td></tr></table></blockquote>'
      ).surface
    ).toBe('native')
    expect(
      mailPresentationForHtml(
        '<div>Sounds good</div><div class="gmail_quote"><style>.quote{margin:0;color:#111}</style><div class="quote">Original plain note</div></div>'
      ).surface
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

    for (const html of designedMessages) expect(mailPresentationForHtml(html).surface).toBe('light')
  })

  it('keeps framed white transactional templates on their sender-owned light canvas', () => {
    const googleTransactional = `<table width="100%" bgcolor="#ffffff"><tr><td>
      <table bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;
        border-top:25px solid #e5e5e5;border-right:25px solid #e5e5e5;
        border-bottom:25px solid #e5e5e5;border-left:25px solid #e5e5e5">
        <tr><td style="color:#808080">Action required</td></tr>
      </table>
    </td></tr></table>`

    expect(mailPresentationForHtml(googleTransactional).surface).toBe('light')
    expect(mailPresentationForHtml('<div style="border:1px solid #ddd">Ordinary note</div>')).toMatchObject({
      surface: 'native'
    })
    expect(
      mailPresentationForHtml('<blockquote style="border-left:25px solid #ddd">Quote</blockquote>').surface
    ).toBe('native')
  })

  it('ignores stylesheet background rules that cannot match the message', () => {
    expect(mailPresentationForHtml('<style>.unused{background:#123456}</style><p>Hello</p>')).toMatchObject({
      surface: 'native'
    })
    expect(
      mailPresentationForHtml(
        '<style>@media (max-width:600px){.unused{background:#123456}}</style><p>Hello</p>'
      ).surface
    ).toBe('native')
    expect(
      mailPresentationForHtml(
        '<style>[data-label="a,b"]{background:#123456}</style><p data-label="a,b">Hello</p>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml('<style>.button:hover{background:#123456}</style><a class="button">Open</a>')
        .surface
    ).toBe('light')
    expect(
      mailPresentationForHtml('<style>p{background:#123456;background:transparent}</style><p>Hello</p>')
        .surface
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
    for (const html of neutralMessages) expect(mailPresentationForHtml(html).surface).toBe('native')

    const designedMessages = [
      '<style>.card{background:transparent}.card{background:#123456}</style><div class="card">Designed</div>',
      '<style>.card{background:#123456!important}.card{background:transparent}</style><div class="card">Designed</div>',
      '<style>div.card{background:#123456}.card{background:transparent}</style><div class="card">Designed</div>',
      '<style>.card{background:#123456!important}</style><div class="card" style="background:transparent">Designed</div>'
    ]
    for (const html of designedMessages) expect(mailPresentationForHtml(html).surface).toBe('light')
  })

  it('accepts browser-valid important syntax on inline backgrounds', () => {
    expect(
      mailPresentationForHtml('<div style="background:#123456 ! important">Designed mail</div>').surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<div style="background:#123456!important/* template note */">Designed mail</div>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml('<div style="background:#fff ! important/* template note */">Plain mail</div>')
        .surface
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

    for (const html of neutralMessages) expect(mailPresentationForHtml(html).surface).toBe('native')
  })

  it('ignores canvases that exist only in a dark color-scheme media query', () => {
    expect(
      mailPresentationForHtml(
        '<style>@media screen and (prefers-color-scheme:dark){body{background:#111}}body{color:#222}</style><p>Dark-capable note</p>'
      ).surface
    ).toBe('native')
    expect(
      mailPresentationForHtml(
        '<style>@media (prefers-color-scheme:light){body{background:#fff3d6}}</style><p>Designed note</p>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<style>@media (prefers-color-scheme:dark), (max-width:600px){body{background:#fff3d6}}</style><p>Responsive design</p>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<style>@media not (prefers-color-scheme:dark){body{background:#fff3d6}}</style><p>Light-only design</p>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<style>@media not screen and (prefers-color-scheme:dark){body{background:#fff3d6}}</style><p>Negated dark design</p>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<style>@media not screen and (prefers-color-scheme:light){body{background:#fff3d6}}</style><p>Negated light design</p>'
      ).surface
    ).toBe('native')
  })

  it('ignores print-only backgrounds when resolving the screen canvas', () => {
    expect(
      mailPresentationForHtml(
        '<style>@media print{.receipt{background:#123456}}</style><p class="receipt">Receipt</p>'
      ).surface
    ).toBe('native')

    expect(
      mailPresentationForHtml(
        '<style>body{background:#fff}@media print{#receipt{background:#fff!important}#summary{background:#fff!important;color:#000!important}table{background:#fff!important}}</style><div style="display:none">Preview</div><table id="receipt" width="100%" bgcolor="#ecf0f1"><tr><td id="summary" style="background:#2c3d4f;color:#fff">Confirmed order</td></tr></table>'
      ).surface
    ).toBe('light')

    expect(
      mailPresentationForHtml(
        '<style>@media print, screen and (prefers-color-scheme:dark){body{background:#111}}</style><p>Screen note</p>'
      ).surface
    ).toBe('native')
  })

  it('preserves a real authored canvas inside forwarded content', () => {
    const forwarded =
      '<div class="gmail_quote"><table bgcolor="#f6d5c4"><tr><td>Summit agenda</td></tr></table></div>'
    expect(
      mailPresentationForHtml(`<div>---------- Forwarded message ----------</div>${forwarded}`).surface
    ).toBe('light')
    expect(mailPresentationForHtml(`<div>FYI</div>${forwarded}`).surface).toBe('light')
    expect(
      mailPresentationForHtml(
        '<div class="gmail_quote"><style>.hero{background:#fff3d6}</style><div class="hero">Designed</div></div>'
      ).surface
    ).toBe('light')
    expect(
      mailPresentationForHtml(
        '<style>.gmail_quote{background:#f6d5c4}</style><div class="gmail_quote">Quoted design</div>'
      ).surface
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

describe('forceLightMailCss', () => {
  it('disables dark color-scheme conditions without changing other media queries', () => {
    const css = `
      @media (prefers-color-scheme: dark) { .copy { color: white; } }
      @media(PREFERS-COLOR-SCHEME:DARK), (max-width: 600px) { .stack { display: block; } }
      @media (prefers-color-scheme: light) { .copy { color: black; } }
    `

    const result = forceLightMailCss(css)

    expect(result).not.toMatch(/prefers-color-scheme\s*:\s*dark/i)
    expect(result).toContain('(width < 0px)')
    expect(result).toContain('(width < 0px), (max-width: 600px)')
    expect(result).toContain('(prefers-color-scheme: light)')
  })

  it('keeps a negated dark query true on the forced-light canvas', () => {
    const css = '@media not screen and (prefers-color-scheme:dark) { .copy { background: #fff3d6; } }'

    expect(forceLightMailCss(css)).toContain('@media not screen and (width < 0px)')
  })

  it('does not alter color declarations or prose mentioning dark mode', () => {
    const css = '.copy { color: darkblue; } /* prefers-color-scheme: dark */'

    expect(forceLightMailCss(css)).toBe(css)
  })
})
