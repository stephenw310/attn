import { describe, expect, it } from 'vitest'
import { extractBodyText, hasAttachment, parseAddress } from './parse'

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
    expect(hasAttachment({ parts: [{ filename: 'receipt.pdf' }] })).toBe(true)
  })
})
