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
    const html = '<section data-layout="card" onclick="steal()"><mark>Safe text</mark></section>'
    const restored = restoreOpaqueHtml(sanitizeOutgoingHtml(prepareHtmlForEditor(html).html))

    expect(restored).toContain('<section data-layout="card">')
    expect(restored).not.toContain('onclick')
  })
})
