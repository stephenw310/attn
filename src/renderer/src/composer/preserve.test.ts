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
