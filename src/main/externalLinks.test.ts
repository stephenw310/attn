import { describe, expect, it } from 'vitest'
import { isOpenableExternalUrl } from './externalLinks'

describe('isOpenableExternalUrl', () => {
  it('opens the three schemes a mail link may hand to the OS', () => {
    expect(isOpenableExternalUrl('https://example.com/a?b=c#d')).toBe(true)
    expect(isOpenableExternalUrl('http://example.com')).toBe(true)
    expect(isOpenableExternalUrl('mailto:ada@example.com?subject=Hi')).toBe(true)
    // The scheme is matched case-insensitively, as URL parsing normalizes it.
    expect(isOpenableExternalUrl('HTTPS://example.com')).toBe(true)
  })

  it('refuses every other scheme a sanitized mail body can still carry', () => {
    for (const url of [
      'tel:+15551234567',
      'sms:+15551234567',
      'callto:someone',
      'xmpp:someone@example.com',
      'matrix:u/someone:example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<h1>hi</h1>',
      'cid:part1@example.com',
      'ms-msdt:/id',
      ''
    ]) {
      expect(isOpenableExternalUrl(url)).toBe(false)
    }
  })

  it('refuses anything that is not an absolute URL', () => {
    expect(isOpenableExternalUrl('/relative/path')).toBe(false)
    expect(isOpenableExternalUrl('example.com')).toBe(false)
    expect(isOpenableExternalUrl('   ')).toBe(false)
  })
})
