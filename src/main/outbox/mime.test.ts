import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MailAddress } from '../../shared/mail'
import { buildMime, type MimeDraft, mimeByteLength, streamMime, validateMimeRecipients } from './mime'

const OPTIONS = {
  accountEmail: 'me@example.com',
  rfcMessageId: '<attn-123@example.com>',
  date: new Date('2026-08-13T12:34:56.000Z')
}

it('wraps inline CID images in multipart/related', () => {
  const mime = buildMime(
    {
      to: [{ name: '', email: 'to@example.com' }],
      subject: 'Inline image',
      bodyText: 'Image',
      bodyHtml: '<p><img src="cid:hero@attn.local"></p>',
      attachments: [
        {
          filename: 'hero.png',
          mimeType: 'image/png',
          content: Uint8Array.from([1, 2, 3]),
          contentId: 'hero@attn.local',
          inline: true
        }
      ]
    },
    { accountEmail: 'me@example.com', rfcMessageId: '<inline@attn.local>', date: new Date(0) }
  )
  expect(mime).toContain('Content-Type: multipart/related;')
  expect(mime).toContain('Content-Disposition: inline; filename="hero.png"')
  expect(mime).toContain('Content-ID: <hero@attn.local>')
})

it('streams spooled attachment bytes with framing identical to the buffered builder', async () => {
  const content = Buffer.from(Array.from({ length: 65_536 }, (_, index) => index))
  const base = {
    to: [{ name: '', email: 'to@example.com' }],
    subject: 'Streamed attachment',
    bodyText: 'Body',
    bodyHtml: '<p>Body</p>'
  }
  const buffered = buildMime(
    {
      ...base,
      attachments: [{ filename: 'bytes.bin', mimeType: 'application/octet-stream', content }]
    },
    OPTIONS
  )
  const completed: number[] = []
  const chunks: Buffer[] = []
  const streamedDraft = {
    ...base,
    attachments: [
      {
        filename: 'bytes.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: content.byteLength,
        open: async function* () {
          yield content.subarray(0, 11)
          yield content.subarray(11, 103)
          yield content.subarray(103)
        }
      }
    ]
  }
  for await (const chunk of streamMime(streamedDraft, OPTIONS, (_attachment, index) =>
    completed.push(index)
  )) {
    chunks.push(Buffer.from(chunk))
  }

  const streamed = Buffer.concat(chunks)
  expect(streamed.toString()).toBe(buffered)
  expect(mimeByteLength(streamedDraft, OPTIONS)).toBe(streamed.byteLength)
  expect(chunks.length).toBeLessThan(100)
  expect(completed).toEqual([0])
})

it('sizes an empty streamed attachment exactly', async () => {
  const draft = {
    to: [{ name: '', email: 'to@example.com' }],
    subject: 'Empty attachment',
    bodyText: '',
    bodyHtml: '',
    attachments: [
      {
        filename: 'empty.txt',
        mimeType: 'text/plain',
        sizeBytes: 0,
        open: async function* () {}
      }
    ]
  }
  const chunks: Buffer[] = []
  for await (const chunk of streamMime(draft, OPTIONS)) chunks.push(Buffer.from(chunk))
  expect(mimeByteLength(draft, OPTIONS)).toBe(Buffer.concat(chunks).byteLength)
})

const CASES: { fixture: string; draft: MimeDraft }[] = [
  {
    fixture: 'simple-text.eml',
    draft: {
      to: [{ name: 'Maya Lin', email: 'maya@example.com' }],
      subject: 'Hello',
      bodyText: 'Hello there.',
      bodyHtml: ''
    }
  },
  {
    fixture: 'html-alternative.eml',
    draft: {
      to: [{ name: 'Maya Lin', email: 'maya@example.com' }],
      cc: [{ name: 'Dev Team', email: 'dev@example.com' }],
      bcc: [{ name: '', email: 'archive@example.com' }],
      subject: 'Quarterly update',
      bodyText: 'Hi team,\n\nThe plan is ready.',
      bodyHtml: '<p>Hi <strong>team</strong>,</p><p>The plan is ready.</p>'
    }
  },
  {
    fixture: 'attachment.eml',
    draft: {
      to: [{ name: 'Maya Lin', email: 'maya@example.com' }],
      subject: 'Receipt',
      bodyText: 'Attached.',
      bodyHtml: '<p>Attached.</p>',
      attachments: [
        {
          filename: 'receipt.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('PDF-DATA\n'),
          contentId: 'future-inline@example.com'
        }
      ]
    }
  },
  {
    fixture: 'unicode.eml',
    draft: {
      to: [{ name: 'Zoë Chen', email: 'zoe@example.com' }],
      subject: 'Résumé for Zoë 📬',
      bodyText: 'Café notes.',
      bodyHtml: '<p>Café notes.</p>',
      attachments: [
        {
          filename: 'résumé 计划.pdf',
          mimeType: 'application/pdf',
          content: Uint8Array.from([0, 1, 2, 250, 255])
        }
      ]
    }
  },
  {
    fixture: 'reply-references.eml',
    draft: {
      to: [{ name: 'Maya Lin', email: 'maya@example.com' }],
      subject: 'Re: Roadmap',
      bodyText: 'Sounds good.',
      bodyHtml: '<p>Sounds good.</p>',
      quoteText: 'On Thu, 13 Aug 2026 11:00:00 GMT, Maya Lin <maya@example.com> wrote:\n> Ship it.',
      quoteHtml:
        '<div>On Thu, 13 Aug 2026 11:00:00 GMT, Maya Lin &lt;maya@example.com&gt; wrote:</div><blockquote><p>Ship it.</p></blockquote>',
      inReplyTo: '<reply@example.com>',
      references: ['<root@example.com>', '<reply@example.com>']
    }
  }
]

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n')
}

function parseTopHeaders(raw: string): Map<string, string> {
  const headerBlock = raw.split('\r\n\r\n', 1)[0]
  const unfolded: string[] = []
  for (const line of headerBlock.split('\r\n')) {
    if (/^[ \t]/.test(line)) {
      const last = unfolded.length - 1
      if (last < 0) throw new Error('orphaned folded header')
      unfolded[last] += ` ${line.trim()}`
    } else {
      unfolded.push(line)
    }
  }
  return new Map(
    unfolded.map((line) => {
      const separator = line.indexOf(':')
      if (separator <= 0) throw new Error(`malformed header: ${line}`)
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()]
    })
  )
}

describe('MIME builder', () => {
  it.each(CASES)('matches the $fixture golden file', ({ fixture: fixtureName, draft }) => {
    expect(buildMime(draft, OPTIONS)).toBe(fixture(fixtureName))
  })

  it('uses deterministic, message-specific boundaries and CRLF throughout', () => {
    const draft = CASES[2].draft
    const first = buildMime(draft, OPTIONS)
    const repeated = buildMime(draft, OPTIONS)
    const differentId = buildMime(draft, { ...OPTIONS, rfcMessageId: '<other@example.com>' })

    expect(repeated).toBe(first)
    expect(differentId).not.toBe(first)
    expect(first).not.toMatch(/(^|[^\r])\n/)
  })

  it('base64-wraps attachment content at no more than 76 columns', () => {
    const raw = buildMime(
      {
        to: [{ name: '', email: 'maya@example.com' }],
        subject: 'Large attachment',
        bodyText: '',
        bodyHtml: '',
        attachments: [
          {
            filename: 'bytes.bin',
            mimeType: 'application/octet-stream',
            content: Buffer.alloc(240, 0xab)
          }
        ]
      },
      OPTIONS
    )
    const attachmentBody = raw
      .split('Content-Disposition: attachment; filename="bytes.bin"\r\n\r\n')[1]
      .split('\r\n--attn-mixed-', 1)[0]

    expect(attachmentBody.split('\r\n').every((line) => line.length <= 76)).toBe(true)
  })

  it('rejects a missing Message-ID or invalid date', () => {
    expect(() => buildMime(CASES[0].draft, { ...OPTIONS, rfcMessageId: '\r\n' })).toThrow(
      'Message-ID is required'
    )
    expect(() => buildMime(CASES[0].draft, { ...OPTIONS, date: new Date('invalid') })).toThrow(
      'date must be valid'
    )
  })

  it('rejects missing recipients and addr-spec separator injection', () => {
    expect(() => validateMimeRecipients({ ...CASES[0].draft, to: [] }, OPTIONS.accountEmail)).toThrow(
      'at least one recipient'
    )
    expect(() =>
      buildMime(
        {
          ...CASES[0].draft,
          to: [{ name: '', email: 'maya@example.com, spy@evil.example' }]
        },
        OPTIONS
      )
    ).toThrow('one valid addr-spec')
    expect(() =>
      buildMime(CASES[0].draft, { ...OPTIONS, accountEmail: 'me@example.com; spy@evil.example' })
    ).toThrow('one valid addr-spec')
  })

  it('serializes internationalized domains as an ASCII IDN', () => {
    const raw = buildMime(
      {
        ...CASES[0].draft,
        to: [{ name: 'München', email: 'user@münchen.de' }]
      },
      OPTIONS
    )

    expect(parseTopHeaders(raw).get('to')).toBe('=?UTF-8?B?TcO8bmNoZW4=?= <user@xn--mnchen-3ya.de>')
  })

  it('uses RFC 2231 continuations for long Unicode filenames', () => {
    const filename = `${'界'.repeat(85)}.pdf`
    const raw = buildMime(
      {
        ...CASES[0].draft,
        attachments: [
          {
            filename,
            mimeType: 'application/pdf',
            content: Buffer.from('data')
          }
        ]
      },
      OPTIONS
    )
    const attachmentStart = raw.indexOf('Content-Type: application/pdf')
    const attachmentEnd = raw.indexOf('\r\n\r\n', attachmentStart)
    const attachmentHeaders = raw.slice(attachmentStart, attachmentEnd).split('\r\n')
    const continuations = [...raw.matchAll(/filename\*(\d+)\*=([^;\r\n]+)/g)]

    expect(continuations.length).toBeGreaterThan(1)
    expect(continuations.map((match) => Number(match[1]))).toEqual(
      Array.from({ length: continuations.length }, (_, index) => index)
    )
    const encoded = continuations
      .map((match) => match[2])
      .join('')
      .replace(/^UTF-8''/, '')
    expect(decodeURIComponent(encoded)).toBe(filename)
    expect(attachmentHeaders.every((line) => Buffer.byteLength(line) <= 78)).toBe(true)
  })

  it('preserves the extension in a truncated ASCII filename fallback', () => {
    const raw = buildMime(
      {
        ...CASES[0].draft,
        attachments: [
          {
            filename: 'quarterly-report-for-the-board-of-directors-2026.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('data')
          }
        ]
      },
      OPTIONS
    )
    const fallback = raw.match(/filename="([^"]+)"/)?.[1]

    expect(fallback).toHaveLength(40)
    expect(fallback).toMatch(/\.pdf$/)
  })

  it('round-trips generated top-level headers through a naive splitter', () => {
    const names = ['', 'Plain Name', 'Dvořák, Antonín']
    const subjects = ['', 'ASCII subject', 'Привет мир', 'line one\r\nBcc: injected']
    for (let index = 0; index < 48; index++) {
      const address: MailAddress = {
        name: names[index % names.length],
        email: `person${index}@example.com`
      }
      const bcc =
        index % 4 === 0
          ? Array.from({ length: 5 }, (_, recipient) => ({
              name: `Blind Copy ${recipient}`,
              email: `blind-${index}-${recipient}@example.com`
            }))
          : []
      const references = Array.from(
        { length: 12 + (index % 8) },
        (_, reference) => `<thread-${index}-${reference}-${'x'.repeat(18)}@example.com>`
      )
      const raw = buildMime(
        {
          to: [address],
          cc: index % 2 ? [{ name: 'Copy', email: 'copy@example.com' }] : [],
          bcc,
          subject: subjects[index % subjects.length],
          bodyText: `Text ${index}`,
          bodyHtml: `<p>Text ${index}</p>`,
          quoteText: `On an earlier message:\n> Quote ${index}`,
          quoteHtml: `<blockquote><p>Quote ${index}</p></blockquote>`,
          inReplyTo: `<reply-${index}@example.com>`,
          references,
          attachments:
            index % 3 === 0
              ? [{ filename: `file-${index}.txt`, mimeType: 'text/plain', content: Buffer.from('data') }]
              : []
        },
        { ...OPTIONS, rfcMessageId: `<attn-${index}@example.com>` }
      )
      const headers = parseTopHeaders(raw)
      expect(headers.get('from')).toBe('me@example.com')
      expect(headers.get('message-id')).toBe(`<attn-${index}@example.com>`)
      expect(headers.get('in-reply-to')).toBe(`<reply-${index}@example.com>`)
      expect(headers.get('references')).toBe(references.join(' '))
      expect(headers.get('mime-version')).toBe('1.0')
      expect(headers.get('content-type')).toMatch(/^multipart\/(?:alternative|mixed); boundary=/)
      if (bcc.length > 0) {
        expect(headers.get('bcc')).toBe(bcc.map((address) => `${address.name} <${address.email}>`).join(', '))
      } else {
        expect(headers.has('bcc')).toBe(false)
      }
      const topHeaderBlock = raw.split('\r\n\r\n', 1)[0]
      expect(topHeaderBlock.split('\r\n').every((line) => Buffer.byteLength(line) <= 998)).toBe(true)
    }
  })
})
