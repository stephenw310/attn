import { describe, expect, it } from 'vitest'
import { type ContactStats, rankContacts } from './contacts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 13)

function contact(overrides: Partial<ContactStats> = {}): ContactStats {
  return {
    name: 'Avery Stone',
    email: 'avery@example.com',
    sentToCount: 1,
    receivedCount: 1,
    lastInteractedAt: NOW,
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

  it('places name or address prefixes ahead of stronger infix matches', () => {
    const ranked = rankContacts(
      [
        contact({ name: 'Malik', email: 'malik@example.com', sentToCount: 100 }),
        contact({ name: 'Ali Chen', email: 'ali@example.com', sentToCount: 1 })
      ],
      'ali',
      'self@example.com',
      NOW
    )

    expect(ranked.map((result) => result.email)).toEqual(['ali@example.com', 'malik@example.com'])
  })

  it('excludes the signed-in address case-insensitively', () => {
    expect(
      rankContacts(
        [contact({ name: 'Me', email: 'SELF@EXAMPLE.COM' }), contact()],
        '',
        'self@example.com',
        NOW
      ).map((result) => result.email)
    ).toEqual(['avery@example.com'])
  })
})
