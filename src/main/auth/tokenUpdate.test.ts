import { describe, expect, it } from 'vitest'
import type { TokenSet } from './googleAuth'
import { isCurrentTokenUpdate } from './tokenUpdate'

const TOKENS: TokenSet = {
  access_token: 'current-access',
  refresh_token: 'refresh',
  expires_at: 1,
  email: 'user@example.com'
}

describe('isCurrentTokenUpdate', () => {
  it('accepts a refresh from the current authentication generation', () => {
    expect(
      isCurrentTokenUpdate(2, TOKENS, {
        generation: 2,
        tokens: { ...TOKENS, access_token: 'refreshed-access' }
      })
    ).toBe(true)
  })

  it('rejects refreshes after sign-out or an account change', () => {
    expect(isCurrentTokenUpdate(3, null, { generation: 2, tokens: TOKENS })).toBe(false)
    expect(isCurrentTokenUpdate(3, TOKENS, { generation: 2, tokens: TOKENS })).toBe(false)
    expect(
      isCurrentTokenUpdate(3, TOKENS, {
        generation: 3,
        tokens: { ...TOKENS, email: 'other@example.com' }
      })
    ).toBe(false)
  })
})
