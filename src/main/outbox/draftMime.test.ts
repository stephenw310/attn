import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodeDraftMessage } from './draftMime'

function decode(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString()
}

describe('draft checkpoint MIME', () => {
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
    const encodedBody = raw.split('\r\n\r\n')[1].replaceAll('\r\n', '')
    expect(Buffer.from(encodedBody, 'base64').toString()).toBe('<p>Olá 👋</p>')
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
