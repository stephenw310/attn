import { describe, expect, it } from 'vitest'
import { needsBodyHydration } from './bodyHydration'

describe('needsBodyHydration', () => {
  it.each([
    { bodyText: null, bodyHtml: null },
    { bodyText: '', bodyHtml: null },
    { bodyText: '  ', bodyHtml: '\n' }
  ])('identifies metadata-only stored bodies: $bodyText / $bodyHtml', (body) => {
    expect(needsBodyHydration(body)).toBe(true)
  })

  it.each([
    { bodyText: 'A complete short message', bodyHtml: null },
    { bodyText: null, bodyHtml: '<p>A complete HTML message</p>' },
    { bodyText: 'Plain fallback', bodyHtml: '<p>HTML message</p>' }
  ])('accepts either cached body representation: $bodyText / $bodyHtml', (body) => {
    expect(needsBodyHydration(body)).toBe(false)
  })
})
