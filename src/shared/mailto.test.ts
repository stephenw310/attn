import { describe, expect, it } from 'vitest'
import { emptyMailtoPrefill, parseMailtoUrl } from './mailto'

function emails(url: string, field: 'to' | 'cc' | 'bcc' = 'to'): string[] {
  return (parseMailtoUrl(url)?.[field] ?? []).map((address) => address.email)
}

describe('parseMailtoUrl', () => {
  it('reads a plain address and an address list before the query', () => {
    expect(emails('mailto:alex@example.com')).toEqual(['alex@example.com'])
    expect(emails('mailto:alex@example.com,sam@example.com')).toEqual(['alex@example.com', 'sam@example.com'])
  })

  it('keeps a display name the link supplies', () => {
    expect(parseMailtoUrl('mailto:%22Alex%20Morgan%22%20%3Calex@example.com%3E')?.to).toEqual([
      { name: 'Alex Morgan', email: 'alex@example.com' }
    ])
  })

  it('merges the path recipients with every to= field', () => {
    expect(emails('mailto:alex@example.com?to=sam@example.com&to=kim@example.com')).toEqual([
      'alex@example.com',
      'sam@example.com',
      'kim@example.com'
    ])
    expect(emails('mailto:?to=alex@example.com')).toEqual(['alex@example.com'])
  })

  it('treats + as a literal, which URLSearchParams would turn into a space', () => {
    expect(emails('mailto:alex+receipts@example.com')).toEqual(['alex+receipts@example.com'])
    expect(parseMailtoUrl('mailto:?subject=a+b')?.subject).toBe('a+b')
  })

  it('decodes a percent-encoded subject and body and normalizes CRLF', () => {
    const prefill = parseMailtoUrl('mailto:?subject=Q3%20plan&body=First%20line%0D%0A%0D%0ASecond%20line')
    expect(prefill?.subject).toBe('Q3 plan')
    expect(prefill?.bodyText).toBe('First line\n\nSecond line')
  })

  it('accepts an uppercase scheme and uppercase header names', () => {
    const prefill = parseMailtoUrl('MAILTO:alex@example.com?SUBJECT=Hi&Cc=sam@example.com')
    expect(prefill?.subject).toBe('Hi')
    expect(prefill?.cc.map((address) => address.email)).toEqual(['sam@example.com'])
  })

  it('ignores unknown headers, attachments included', () => {
    const prefill = parseMailtoUrl(
      'mailto:alex@example.com?attach=/etc/passwd&attachment=C:%5Csecret.txt&in-reply-to=%3Cx%3E'
    )
    expect(prefill).toEqual({ ...emptyMailtoPrefill(), to: [{ name: 'alex', email: 'alex@example.com' }] })
  })

  it('drops only the field a malformed escape damages', () => {
    const prefill = parseMailtoUrl('mailto:alex@example.com?subject=%E0%A4%A&body=Kept')
    expect(prefill?.subject).toBe('')
    expect(prefill?.bodyText).toBe('Kept')
    expect(prefill?.to.map((address) => address.email)).toEqual(['alex@example.com'])
  })

  it('drops invalid addresses and deduplicates each field by lowercase email', () => {
    expect(emails('mailto:not-an-address,alex@example.com,ALEX@Example.com')).toEqual(['alex@example.com'])
    expect(emails('mailto:?cc=sam@example.com&cc=sam@example.com', 'cc')).toEqual(['sam@example.com'])
    // The fields are independent: the same address may ride To and Bcc.
    const prefill = parseMailtoUrl('mailto:alex@example.com?bcc=alex@example.com')
    expect(prefill?.bcc.map((address) => address.email)).toEqual(['alex@example.com'])
  })

  it('strips control characters from the subject and keeps tabs in the body', () => {
    const prefill = parseMailtoUrl('mailto:?subject=Hi%0D%0ABcc:%20x@y.z&body=a%09b%00c')
    expect(prefill?.subject).toBe('HiBcc: x@y.z')
    expect(prefill?.bodyText).toBe('a\tbc')
  })

  it('drops a fragment a browser appended to the href', () => {
    const prefill = parseMailtoUrl('mailto:alex@example.com?subject=Hi#section')
    expect(prefill?.subject).toBe('Hi')
    expect(emails('mailto:alex@example.com#section')).toEqual(['alex@example.com'])
  })

  it('opens an empty composer for a bare mailto:', () => {
    expect(parseMailtoUrl('mailto:')).toEqual(emptyMailtoPrefill())
    expect(parseMailtoUrl('mailto:?')).toEqual(emptyMailtoPrefill())
  })

  it('refuses anything that is not a mailto URL', () => {
    for (const value of ['https://example.com', 'attn://compose', 'alex@example.com', '', ' mailto']) {
      expect(parseMailtoUrl(value)).toBeNull()
    }
    expect(parseMailtoUrl(undefined as unknown as string)).toBeNull()
    expect(parseMailtoUrl(42 as unknown as string)).toBeNull()
  })

  it('caps the URL, the recipients, the subject, and the body', () => {
    expect(parseMailtoUrl(`mailto:alex@example.com?body=${'x'.repeat(300_000)}`)).toBeNull()
    const many = Array.from({ length: 150 }, (_, index) => `user${index}@example.com`).join(',')
    expect(parseMailtoUrl(`mailto:${many}`)?.to).toHaveLength(100)
    const long = parseMailtoUrl(`mailto:?subject=${'s'.repeat(1_200)}&body=${'b'.repeat(120_000)}`)
    expect(long?.subject).toHaveLength(998)
    expect(long?.bodyText).toHaveLength(100_000)
  })
})
