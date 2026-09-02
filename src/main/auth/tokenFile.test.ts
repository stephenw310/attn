import { describe, expect, it } from 'vitest'
import type { TokenSet } from './googleAuth'
import {
  isLegacyTokenPayload,
  parseTokenFile,
  removeAccount,
  reorderRoster,
  upsertAccount
} from './tokenFile'

function tokens(email: string | undefined, accessToken = 'access'): TokenSet {
  return { access_token: accessToken, expires_at: 1, ...(email ? { email } : {}) }
}

describe('parseTokenFile', () => {
  it('reads the v2 roster in order and drops malformed or duplicate entries', () => {
    const parsed = parseTokenFile({
      version: 2,
      accounts: [
        { id: 'a@example.com', tokens: tokens('a@example.com') },
        { id: 'b@example.com', tokens: tokens('b@example.com') },
        { id: 'a@example.com', tokens: tokens('a@example.com', 'dup') },
        { id: '', tokens: tokens('c@example.com') },
        { id: 'd@example.com', tokens: { nope: true } },
        null
      ]
    })
    expect(parsed?.accounts.map((account) => account.id)).toEqual(['a@example.com', 'b@example.com'])
    expect(parsed?.accounts[0]?.tokens.access_token).toBe('access')
  })

  it('folds a legacy single token set into a one-account roster keyed by normalized email', () => {
    const legacy = tokens('User@Example.com')
    expect(isLegacyTokenPayload(legacy)).toBe(true)
    const parsed = parseTokenFile(legacy)
    expect(parsed?.accounts).toEqual([{ id: 'user@example.com', tokens: legacy }])
  })

  it('drops a legacy token set without an email instead of inventing an account', () => {
    const parsed = parseTokenFile(tokens(undefined))
    expect(parsed?.accounts).toEqual([])
  })

  it('treats corrupt payloads as signed out', () => {
    expect(parseTokenFile(null)).toBeNull()
    expect(parseTokenFile('nope')).toBeNull()
    expect(parseTokenFile({ version: 3 })).toBeNull()
  })
})

describe('upsertAccount', () => {
  it('appends a new account at the end of the switcher order', () => {
    const roster = upsertAccount([{ id: 'a@example.com', tokens: tokens('a@example.com') }], {
      ...tokens('B@example.com')
    })
    expect(roster.map((account) => account.id)).toEqual(['a@example.com', 'b@example.com'])
  })

  it('refreshes an existing account in place without moving it', () => {
    const roster = upsertAccount(
      [
        { id: 'a@example.com', tokens: tokens('a@example.com') },
        { id: 'b@example.com', tokens: tokens('b@example.com') }
      ],
      tokens('A@Example.com', 'refreshed')
    )
    expect(roster.map((account) => account.id)).toEqual(['a@example.com', 'b@example.com'])
    expect(roster[0]?.tokens.access_token).toBe('refreshed')
  })

  it('refuses tokens that identify no account', () => {
    expect(() => upsertAccount([], tokens(undefined))).toThrow(/email/)
  })
})

describe('removeAccount', () => {
  it('removes only the named account', () => {
    const roster = removeAccount(
      [
        { id: 'a@example.com', tokens: tokens('a@example.com') },
        { id: 'b@example.com', tokens: tokens('b@example.com') }
      ],
      'a@example.com'
    )
    expect(roster.map((account) => account.id)).toEqual(['b@example.com'])
  })
})

describe('reorderRoster', () => {
  const roster = [
    { id: 'a@example.com', tokens: tokens('a@example.com') },
    { id: 'b@example.com', tokens: tokens('b@example.com') },
    { id: 'c@example.com', tokens: tokens('c@example.com') }
  ]

  it('applies an exact permutation and carries each account tokens along', () => {
    const reordered = reorderRoster(roster, ['c@example.com', 'a@example.com', 'b@example.com'])
    expect(reordered.map((account) => account.id)).toEqual([
      'c@example.com',
      'a@example.com',
      'b@example.com'
    ])
    expect(reordered[1]?.tokens).toBe(roster[0]?.tokens)
  })

  it('keeps the newest tokens when a refresh raced the reorder', () => {
    // The caller snapshot may predate a token refresh; reordering the *current*
    // roster keeps whatever tokens it now holds.
    const refreshed = upsertAccount(roster, tokens('B@Example.com', 'newest'))
    const reordered = reorderRoster(refreshed, ['b@example.com', 'c@example.com', 'a@example.com'])
    expect(reordered[0]?.tokens.access_token).toBe('newest')
  })

  it('rejects duplicates, unknown ids, and stale rosters outright', () => {
    expect(() => reorderRoster(roster, ['a@example.com', 'a@example.com', 'b@example.com'])).toThrow(
      /duplicate/
    )
    expect(() => reorderRoster(roster, ['a@example.com', 'b@example.com', 'x@example.com'])).toThrow(
      /unknown/
    )
    // A request from before an account was added or removed is stale, not partial.
    expect(() => reorderRoster(roster, ['a@example.com', 'b@example.com'])).toThrow(/stale/)
    expect(() =>
      reorderRoster(roster.slice(0, 2), ['a@example.com', 'b@example.com', 'c@example.com'])
    ).toThrow(/stale/)
  })
})
