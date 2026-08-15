import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodeDraftMessage } from './draftMime'

function decode(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString()
}

function decodeTextPart(raw: string, mimeType: 'text/plain' | 'text/html'): string {
  const match = new RegExp(
    `Content-Type: ${mimeType.replace('/', '\\/')}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`
  ).exec(raw)
  if (!match) throw new Error(`${mimeType} part missing`)
  return Buffer.from(match[1].replaceAll('\r\n', ''), 'base64').toString()
}

describe('draft checkpoint MIME', () => {
  it('includes reply threading headers in a Gmail draft checkpoint', () => {
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: '', email: 'to@example.com' }],
        cc: [],
        bcc: [{ name: '', email: 'secret@example.com' }],
        subject: 'Re: Notes',
        bodyHtml: '<p>Reply</p>',
        bodyText: 'Reply',
        inReplyTo: '<source@example.com>',
        references: ['<root@example.com>', '<source@example.com>']
      })
    )
    expect(raw).toContain('In-Reply-To: <source@example.com>')
    expect(raw).toContain('References: <root@example.com> <source@example.com>')
    expect(raw).toContain('Bcc: secret@example.com')
  })

  it('RFC 2047-encodes Unicode headers and base64-encodes the UTF-8 body', () => {
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: '李明', email: 'li@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Café',
        bodyHtml: '<p>Olá 👋</p>',
        bodyText: 'Olá 👋'
      })
    )

    expect(raw).toContain('To: =?UTF-8?B?5p2O5piO?= <li@example.com>')
    expect(raw).toContain('Subject: =?UTF-8?B?Q2Fmw6k=?=')
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    expect(decodeTextPart(raw, 'text/plain')).toBe('Olá 👋')
    expect(decodeTextPart(raw, 'text/html')).toBe('<p>Olá 👋</p>')
  })

  it('preserves repeated ASCII whitespace in short subjects', () => {
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: '', email: 'to@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Q3  report',
        bodyHtml: '<p>Body</p>',
        bodyText: 'Body'
      })
    )

    expect(raw).toContain('Subject: Q3  report\r\n')
  })

  it('preserves ordinary attachments alongside the editable body', () => {
    const bytes = Buffer.from('PDF-DATA')
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: '', email: 'to@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Attachment',
        bodyHtml: '<p>Attached</p>',
        bodyText: 'Attached',
        attachments: [
          {
            filename: 'notes.pdf',
            mimeType: 'application/pdf',
            content: bytes
          }
        ]
      })
    )

    expect(raw).toContain('Content-Type: multipart/mixed;')
    expect(raw).toContain('Content-Disposition: attachment; filename="notes.pdf"')
    const encoded = raw
      .split('Content-Disposition: attachment; filename="notes.pdf"\r\n\r\n')[1]
      .split('\r\n--attn-draft-mixed-')[0]
      .replaceAll('\r\n', '')
    expect(Buffer.from(encoded, 'base64')).toEqual(bytes)
  })

  it('mirrors inline CID images as multipart/related without corrupting bytes', () => {
    const bytes = Uint8Array.from([0, 127, 128, 255])
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: '', email: 'to@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Inline',
        bodyHtml: '<p><img src="cid:hero@attn.local"></p>',
        bodyText: '[Image]',
        attachments: [
          {
            filename: 'hero.png',
            mimeType: 'image/png',
            contentId: 'hero@attn.local',
            inline: true,
            content: bytes
          }
        ]
      })
    )

    expect(raw).toContain('Content-Type: multipart/related;')
    expect(raw).toContain('Content-Disposition: inline; filename="hero.png"')
    expect(raw).toContain('Content-ID: <hero@attn.local>')
    const imageBody = raw
      .split('Content-ID: <hero@attn.local>\r\n\r\n')[1]
      .split('\r\n--attn-draft-related-')[0]
      .replaceAll('\r\n', '')
    expect(Buffer.from(imageBody, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('folds long headers and body encoding below transport line limits', () => {
    const raw = decode(
      encodeDraftMessage({
        to: [{ name: 'A'.repeat(1_100), email: 'long@example.com' }],
        cc: [],
        bcc: [],
        subject: 'é'.repeat(1_100),
        bodyHtml: `<p>${'body'.repeat(1_000)}</p>`,
        bodyText: ''
      })
    )
    const [headers, body] = raw.split('\r\n\r\n')
    expect(headers.split('\r\n').every((line) => Buffer.byteLength(line) < 998)).toBe(true)
    expect(body.split('\r\n').every((line) => line.length <= 76)).toBe(true)
  })
})
