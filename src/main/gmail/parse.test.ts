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
    expect(parseAddress('Maya Lin <maya@example.com>')).toEqual({
      name: 'Maya Lin',
      email: 'maya@example.com'
    })
    const payload = {
      parts: [
        {
          mimeType: 'application/pdf',
          filename: 'receipt.pdf',
          body: { attachmentId: 'att-1', size: 24_576 }
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
        sizeBytes: 24_576
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
