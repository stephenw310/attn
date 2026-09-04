import { describe, expect, it } from 'vitest'
import { canonicalizeListIdValue } from './splits'

describe('canonicalizeListIdValue', () => {
  it('keeps only the bracketed identifier a List-Id header advertises', () => {
    expect(canonicalizeListIdValue('Product updates <updates.example.com>')).toBe('<updates.example.com>')
    expect(canonicalizeListIdValue('<updates.example.com>')).toBe('<updates.example.com>')
  })

  it('lowercases and trims so a rule matches the header it was made from', () => {
    // The header path (`persist` stores `canonicalListId(List-Id)`) and the
    // rule path (`normalizedCondition`) both go through here; a rule typed with
    // different case or padding has to end up byte-identical to the stored row.
    const stored = canonicalizeListIdValue(' Product updates <UPDATES.Example.COM> ')
    expect(stored).toBe('<updates.example.com>')
    expect(canonicalizeListIdValue('  <Updates.Example.com>  ')).toBe(stored)
    expect(canonicalizeListIdValue(stored)).toBe(stored)
  })

  it('unfolds a header split across continuation lines', () => {
    expect(canonicalizeListIdValue('Product updates\r\n <updates.example.com>')).toBe('<updates.example.com>')
    expect(canonicalizeListIdValue('Weekly.\r\n\tExample.COM')).toBe('weekly. example.com')
    expect(canonicalizeListIdValue('Product\n\t<updates.example.com>')).toBe('<updates.example.com>')
  })

  it('takes the first bracketed group when a header carries several', () => {
    expect(canonicalizeListIdValue('<first.example.com> <second.example.com>')).toBe('<first.example.com>')
  })

  it('trims inside the brackets', () => {
    expect(canonicalizeListIdValue('<  updates.example.com  >')).toBe('<updates.example.com>')
  })

  it('falls back to the whole value when nothing is bracketed', () => {
    expect(canonicalizeListIdValue('updates.example.com')).toBe('updates.example.com')
    // Unbalanced or empty brackets are not an identifier; the caller still gets
    // a comparable string rather than a silent empty match.
    expect(canonicalizeListIdValue('<updates.example.com')).toBe('<updates.example.com')
    expect(canonicalizeListIdValue('<>')).toBe('<>')
  })

  it('reports an empty value for blank input', () => {
    // `canonicalListId` turns this into null, which is what keeps a missing
    // List-Id header out of the stored column and out of `listIdPresent`.
    expect(canonicalizeListIdValue('')).toBe('')
    expect(canonicalizeListIdValue('   \r\n\t ')).toBe('')
  })
})
