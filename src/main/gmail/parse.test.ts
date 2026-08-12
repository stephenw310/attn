import { describe, expect, it } from 'vitest'
import { collectAttachments, extractBodyText, hasAttachment, parseAddress, parseAddressList } from './parse'

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
        { mimeType: 'text/plain', filename: '', body: { attachmentId: 'external-body' } }
      ]
    }
    expect(hasAttachment(payload)).toBe(true)
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
      }
    ])
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
})
