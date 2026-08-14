import { describe, expect, it } from 'vitest'
import { type ContactStats, displayName, foldForSearch, rankContacts } from './contacts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 13)

function contact(overrides: Partial<ContactStats> = {}): ContactStats {
  return {
    email: 'avery@example.com',
    sentToCount: 1,
    receivedCount: 1,
    lastInteractedAt: NOW,
    nameMatchesPrefix: false,
    ...overrides
  }
}

describe('contact ranking', () => {
  it('weights sent mail three-to-one and halves the score every 90 days', () => {
    const [recent, old] = rankContacts(
      [contact(), contact({ email: 'old@example.com', lastInteractedAt: NOW - 90 * DAY })],
      '',
      'self@example.com',
      NOW
    )

    expect(recent.score).toBe(4)
    expect(old.score).toBe(2)
  })

  it('places address prefixes ahead of stronger infix matches', () => {
    const ranked = rankContacts(
      [contact({ email: 'malik@example.com', sentToCount: 100 }), contact({ email: 'ali@example.com' })],
      'ali',
      'self@example.com',
      NOW
    )

    expect(ranked.map((result) => result.email)).toEqual(['ali@example.com', 'malik@example.com'])
  })

  it('treats a store-reported name prefix as a prefix match', () => {
    const ranked = rankContacts(
      [
        contact({ email: 'm@example.com', sentToCount: 100 }),
        contact({ email: 'z@example.com', nameMatchesPrefix: true })
      ],
      'ali',
      'self@example.com',
      NOW
    )

    expect(ranked.map((result) => result.email)).toEqual(['z@example.com', 'm@example.com'])
  })

  it('excludes the signed-in address case-insensitively', () => {
    expect(
      rankContacts([contact({ email: 'SELF@EXAMPLE.COM' }), contact()], '', 'self@example.com', NOW).map(
        (result) => result.email
      )
    ).toEqual(['avery@example.com'])
  })
})

describe('search folding', () => {
  it('folds non-ASCII case, which SQLite lower() leaves alone', () => {
    expect(foldForSearch('  Ürsula Groß  ')).toBe('ürsula groß')
    expect(foldForSearch('Maya@Example.COM')).toBe('maya@example.com')
  })
})

describe('display name fallback', () => {
  it('falls back to the local part when no correspondent supplied a name', () => {
    expect(displayName('Maya Lin', 'maya@example.com')).toBe('Maya Lin')
    expect(displayName('  ', 'maya@example.com')).toBe('maya')
    expect(displayName(null, 'maya@example.com')).toBe('maya')
  })
})
