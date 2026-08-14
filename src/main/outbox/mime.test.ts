import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MailAddress } from '../../shared/mail'
import { buildMime, type MimeDraft } from './mime'

const OPTIONS = {
  accountEmail: 'me@example.com',
  rfcMessageId: '<attn-123@example.com>',
  date: new Date('2026-08-13T12:34:56.000Z')
}

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

  it('round-trips generated top-level headers through a naive splitter', () => {
    const names = ['', 'Plain Name', 'Dvořák, Antonín']
    const subjects = ['', 'ASCII subject', 'Привет мир', 'line one\r\nBcc: injected']
    for (let index = 0; index < 48; index++) {
      const address: MailAddress = {
        name: names[index % names.length],
        email: `person${index}@example.com`
      }
      const raw = buildMime(
        {
          to: [address],
          cc: index % 2 ? [{ name: 'Copy', email: 'copy@example.com' }] : [],
          subject: subjects[index % subjects.length],
          bodyText: `Text ${index}`,
          bodyHtml: `<p>Text ${index}</p>`,
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
      expect(headers.get('mime-version')).toBe('1.0')
      expect(headers.get('content-type')).toMatch(/^multipart\/(?:alternative|mixed); boundary=/)
      expect([...headers.keys()].filter((name) => name === 'bcc')).toHaveLength(0)
    }
  })
})
