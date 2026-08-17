// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { draftHtmlFidelityIssues, prepareHtmlForEditor, restoreOpaqueHtml } from './preserve'
import { sanitizeOutgoingHtml } from './sanitize'

describe('composer HTML fidelity', () => {
  it('recognizes Gmail rich content as editable', () => {
    const html =
      '<div style="text-align:center"><span style="font-family:Arial; font-size:18px; color:#c00; background-color:#ffc">Hi</span><img src="cid:hero"><table><tbody><tr><td>Cell</td></tr></tbody></table></div>'
    expect(draftHtmlFidelityIssues(html)).toEqual([])
    const prepared = prepareHtmlForEditor(html)
    expect(prepared.issues).toEqual([])
    expect(prepared.html).toContain('color: #c00')
  })

  it('keeps Gmail CID image metadata on the editable image path', () => {
    const html = '<img data-surl="cid:ii_gmail" src="cid:ii_gmail" alt="Signature image" width="320">'
    const prepared = prepareHtmlForEditor(html)

    expect(prepared.issues).toEqual([])
    expect(prepared.html).toContain('data-surl="cid:ii_gmail"')
    expect(prepared.html).toContain('width="320"')
    expect(prepared.html).not.toContain('data-attn-opaque')
    const outgoing = sanitizeOutgoingHtml(prepared.html)
    expect(outgoing).toContain('data-surl="cid:ii_gmail"')
    expect(outgoing).toContain('width="320"')
  })

  it('keeps a Gmail signature wrapper on the editable path', () => {
    const html =
      '<div class="gmail_signature" data-smartmail="gmail_signature" dir="ltr"><div>Best,</div><a href="https://chaowu.xyz" target="_blank">Chao Wu</a></div>'
    const prepared = prepareHtmlForEditor(html)

    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    expect(prepared.html).toContain('class="gmail_signature"')
    expect(sanitizeOutgoingHtml(prepared.html)).toContain('data-smartmail="gmail_signature"')
    expect(sanitizeOutgoingHtml(prepared.html)).toContain('target="_blank"')
  })

  it('agrees with outgoing sanitization when either Gmail signature marker is present', () => {
    for (const marker of ['class="gmail_signature"', 'data-smartmail="gmail_signature"']) {
      const prepared = prepareHtmlForEditor(`<div ${marker}><div>Best,</div></div>`)

      expect(prepared.issues).toEqual([])
      expect(prepared.html).not.toContain('data-attn-opaque')
      expect(sanitizeOutgoingHtml(prepared.html)).toContain(marker)
    }
  })

  it('returns empty drafts without invoking the HTML preservation pipeline', () => {
    expect(prepareHtmlForEditor('')).toEqual({ html: '', issues: [] })
    expect(prepareHtmlForEditor('   ')).toEqual({ html: '', issues: [] })
  })

  it('keeps a Gmail-authored signature block fully editable', () => {
    // Every Gmail draft with a signature carries `<br clear="all">`. The
    // sanitizer drops `clear` either way, so freezing the remaining `<br>`
    // would preserve nothing and only cost editability.
    const html =
      '<div dir="ltr"><div><br clear="all"></div><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><div>Bests,</div>Chao Wu<div><a href="https://chaowu.xyz" target="_blank">https://chaowu.xyz</a><br></div></div></div></div></div>'
    const prepared = prepareHtmlForEditor(html)

    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    expect(prepared.html).toContain('<br>')
    expect(prepared.html).toContain('https://chaowu.xyz')
  })

  it('still freezes a region that survives sanitization, and reports its nested issues', () => {
    const prepared = prepareHtmlForEditor('<section data-layout="card"><div align="center">x</div></section>')

    expect(prepared.html).toContain('data-attn-opaque=')
    expect(prepared.issues).toEqual(['<section>', 'div[align]'])
  })

  it('does not freeze formatting the import sanitizer removes on its own', () => {
    // `float` and `align` never reach the stored draft either way, so an opaque
    // region would preserve nothing and only cost the user an editable line.
    for (const html of ['<div style="float:left">Floated</div>', '<div align="center">Centered</div>']) {
      const prepared = prepareHtmlForEditor(html)
      expect(prepared.issues).toEqual([])
      expect(prepared.html).not.toContain('data-attn-opaque')
    }
  })

  it('drops a nested issue along with the region that stops being opaque', () => {
    const prepared = prepareHtmlForEditor('<div clear="all"><p clear="all">Text</p></div>')

    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    expect(prepared.html).toContain('Text')
  })

  it('keeps text editable through Gmail editor classes and no-op declarations', () => {
    // What Gmail wraps around typed text in a synced draft. Its class names
    // point at a stylesheet that does not travel with the mail, and the two
    // declarations set nothing, so none of it is formatting worth freezing.
    const prepared = prepareHtmlForEditor(
      '<div dir="ltr"><div><span class="Q6ibn ng" style="border-style:none;background:none">hi</span></div></div>'
    )

    expect(prepared.issues).toEqual([])
    expect(prepared.html).not.toContain('data-attn-opaque')
    expect(prepared.html).toContain('hi')
  })

  it('freezes a class once the document carries a stylesheet that could target it', () => {
    const prepared = prepareHtmlForEditor('<style>.hero{color:red}</style><p class="hero">Designed</p>')

    expect(prepared.issues.length).toBeGreaterThan(0)
    expect(prepared.html).toContain('data-attn-opaque')
  })

  it('keeps Gmail structural markers frozen so a quoted trail survives the round trip', () => {
    // Attn's own trim and surface rules key on `gmail_quote`, and so does
    // Gmail's quote collapsing. Losing the class would break both.
    const html = '<div class="gmail_quote"><div>Original note</div></div>'
    const prepared = prepareHtmlForEditor(html)

    expect(prepared.issues).toContain('div[class]')
    expect(prepared.html).toContain('data-attn-opaque')
    expect(restoreOpaqueHtml(prepared.html)).toBe(html)
  })

  it('turns unknown safe regions opaque and restores their original bytes', () => {
    const html = '<section data-layout="card"><p>Keep <mark>this</mark></p></section>'
    const prepared = prepareHtmlForEditor(html)
    expect(prepared.issues).toContain('<section>')
    expect(prepared.html).toContain('data-attn-opaque=')
    expect(restoreOpaqueHtml(prepared.html)).toBe(html)
    expect(restoreOpaqueHtml(sanitizeOutgoingHtml(prepared.html))).toBe(html)
  })

  it('preserves source casing, quotes, and entities byte-for-byte', () => {
    const html = "<SECTION DATA-LAYOUT='card'><MARK>Keep&nbsp;this</MARK></SECTION>"
    const prepared = prepareHtmlForEditor(html)

    expect(restoreOpaqueHtml(sanitizeOutgoingHtml(prepared.html))).toBe(html)
  })

  it('sanitizes an unsafe opaque region instead of restoring dangerous source', () => {
    const html =
      '<section data-layout="card" dir="sideways" onclick="steal()"><a href="https://attn.test" target="_top">Safe text</a></section>'
    const restored = restoreOpaqueHtml(sanitizeOutgoingHtml(prepareHtmlForEditor(html).html))

    expect(restored).toContain('<section data-layout="card">')
    expect(restored).not.toContain('onclick')
    expect(restored).not.toContain('dir="sideways"')
    expect(restored).not.toContain('target="_top"')
  })
})
