import { describe, expect, it } from 'vitest'
import {
  collectAttachments,
  extractBodyHtml,
  extractBodyText,
  extractThreadingHeaders,
  findExternalTextParts,
  hasCalendarPart,
  hasInlinePlainText,
  parseAddress,
  parseAddressList,
  parseMessageIds
} from './parse'

describe('Gmail message parsing', () => {
  it('prefers plain text and decodes base64url bodies', () => {
    const encode = (value: string): string => Buffer.from(value).toString('base64url')
    expect(
      extractBodyText({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: encode('<b>HTML</b>') } },
          { mimeType: 'text/plain', body: { data: encode('Plain text') } }
        ]
      })
    ).toBe('Plain text')
  })

  it('reads body parts case-insensitively and never from a forwarded message', () => {
    const encode = (value: string): string => Buffer.from(value).toString('base64url')
    const payload = {
      mimeType: 'Multipart/Mixed',
      parts: [
        { mimeType: 'Text/Plain', body: { data: encode('Authored body') } },
        { mimeType: 'TEXT/HTML', body: { data: encode('<b>Authored body</b>') } },
        {
          // A forwarded-as-attachment message: its own text belongs to the
          // attachment, not to this message's body.
          mimeType: 'Message/RFC822',
          filename: 'forwarded.eml',
          parts: [
            { mimeType: 'text/plain', body: { data: encode('Embedded body') } },
            { mimeType: 'text/html', body: { data: encode('<i>Embedded body</i>') } },
            { mimeType: 'text/plain', body: { attachmentId: 'embedded-external', size: 900_000 } }
          ]
        }
      ]
    }

    expect(extractBodyText(payload)).toBe('Authored body')
    expect(extractBodyHtml(payload)).toBe('<b>Authored body</b>')
    expect(hasInlinePlainText(payload)).toBe(true)
    expect(findExternalTextParts(payload)).toEqual([])
    expect(
      findExternalTextParts({
        mimeType: 'Multipart/Alternative',
        parts: [{ mimeType: 'Text/Plain', body: { attachmentId: 'big-text', size: 900_000 } }]
      })
    ).toEqual([{ attachmentId: 'big-text', mimeType: 'text/plain' }])
  })

  it('parses addresses and finds nested attachments', () => {
    const inlineData = Buffer.from('small attachment').toString('base64url')
    expect(parseAddress('Maya Lin <maya@example.com>')).toEqual({
      name: 'Maya Lin',
      email: 'maya@example.com'
    })
    const payload = {
      parts: [
        {
          mimeType: 'application/pdf',
          filename: 'receipt.pdf',
          headers: [{ name: 'Content-ID', value: '<invoice-image@example.test>' }],
          body: { attachmentId: 'att-1', size: 24_576 }
        },
        {
          partId: '2',
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { data: inlineData }
        },
        {
          mimeType: 'image/jpeg',
          filename: 'photo.jpg',
          headers: [
            { name: 'Content-ID', value: '<attached-photo@example.test>' },
            { name: 'Content-Disposition', value: 'attachment; filename="photo.jpg"' }
          ],
          body: { attachmentId: 'att-photo', size: 1_024 }
        },
        { mimeType: 'text/plain', filename: '', body: { attachmentId: 'external-body' } }
      ]
    }
    expect(collectAttachments(payload)).toEqual([
      {
        attachmentId: 'att-1',
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 24_576,
        contentId: 'invoice-image@example.test'
      },
      {
        attachmentId: 'inline:2',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 16,
        inlineData
      },
      {
        attachmentId: 'att-photo',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1_024,
        contentId: 'attached-photo@example.test'
      }
    ])
  })

  it('keeps filename-less CID images without advertising them as attachments', () => {
    const payload = {
      parts: [
        {
          partId: '2.1',
          mimeType: 'image/png',
          filename: '',
          headers: [
            { name: 'Content-ID', value: '<MarcusLogo_2021>' },
            { name: 'Content-Disposition', value: 'inline' }
          ],
          body: { attachmentId: 'logo-data', size: 4_096 }
        }
      ]
    }

    expect(collectAttachments(payload)).toEqual([
      {
        attachmentId: 'logo-data',
        filename: 'MarcusLogo_2021',
        mimeType: 'image/png',
        sizeBytes: 4_096,
        contentId: 'MarcusLogo_2021',
        inline: true
      }
    ])
  })

  it('finds filename-less calendar MIME parts without exposing them as downloads', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Invite').toString('base64url') } },
        { mimeType: 'text/calendar', body: { attachmentId: 'calendar-body', size: 120 } }
      ]
    }

    expect(hasCalendarPart(payload)).toBe(true)
    expect(collectAttachments(payload)).toEqual([])
  })

  it('splits address lists only on top-level commas', () => {
    expect(
      parseAddressList('"Lin, Maya" <maya@example.com>, Priya Raman <priya@example.com>, solo@test.dev')
    ).toEqual([
      { name: 'Lin, Maya', email: 'maya@example.com' },
      { name: 'Priya Raman', email: 'priya@example.com' },
      { name: 'solo', email: 'solo@test.dev' }
    ])
    expect(parseAddressList('')).toEqual([])
  })

  it('extracts canonical angle-bracket message ids from folded References', () => {
    expect(parseMessageIds('<root@example.com>\r\n\t<reply@example.com>')).toEqual([
      '<root@example.com>',
      '<reply@example.com>'
    ])
    expect(parseMessageIds('bare@example.com')).toEqual(['<bare@example.com>'])
    expect(parseMessageIds('one@example.com, two@example.com')).toEqual([
      '<one@example.com>',
      '<two@example.com>'
    ])
    // Junk without an addr-spec must not become an invented id on a later reply.
    expect(parseMessageIds('unknown')).toEqual([])
    expect(parseMessageIds('see the thread below')).toEqual([])

    expect(
      extractThreadingHeaders({
        id: 'm1',
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Message-ID', value: '<message@example.com>' },
            { name: 'References', value: '<root@example.com>\r\n <reply@example.com>' }
          ]
        }
      })
    ).toEqual({
      rfcMessageId: '<message@example.com>',
      references: ['<root@example.com>', '<reply@example.com>']
    })
  })

  it('uses In-Reply-To only when References is absent', () => {
    expect(
      extractThreadingHeaders({
        id: 'm1',
        threadId: 't1',
        payload: {
          headers: [
            { name: 'Message-ID', value: 'message@example.com' },
            { name: 'In-Reply-To', value: '<parent@example.com>' }
          ]
        }
      })
    ).toEqual({ rfcMessageId: '<message@example.com>', references: ['<parent@example.com>'] })
  })
})
