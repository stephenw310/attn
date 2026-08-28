import { describe, expect, it } from 'vitest'
import type { TokenSet } from './googleAuth'
import type { StoredAccount } from './tokenFile'
import { isCurrentTokenUpdate } from './tokenUpdate'

const TOKENS: TokenSet = {
  access_token: 'current-access',
  refresh_token: 'refresh',
  expires_at: 1,
  email: 'user@example.com'
}

const STORED: StoredAccount = { id: 'user@example.com', tokens: TOKENS }

describe('isCurrentTokenUpdate', () => {
  it('accepts a refresh from the account current authentication generation', () => {
    expect(
      isCurrentTokenUpdate(2, STORED, {
        accountId: STORED.id,
        generation: 2,
        tokens: { ...TOKENS, access_token: 'refreshed-access' }
      })
    ).toBe(true)
  })

  it('rejects refreshes after removal or a re-authentication', () => {
    expect(isCurrentTokenUpdate(3, undefined, { accountId: STORED.id, generation: 3, tokens: TOKENS })).toBe(
      false
    )
    expect(isCurrentTokenUpdate(3, STORED, { accountId: STORED.id, generation: 2, tokens: TOKENS })).toBe(
      false
    )
    expect(
      isCurrentTokenUpdate(3, STORED, {
        accountId: STORED.id,
        generation: 3,
        tokens: { ...TOKENS, email: 'other@example.com' }
      })
    ).toBe(false)
  })
})
