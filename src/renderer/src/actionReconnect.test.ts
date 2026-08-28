import { describe, expect, it } from 'vitest'
import type { AuthStatus } from '../../shared/auth'
import { actionReconnectMessage } from './actionReconnect'

function status(configured: boolean, email: string): AuthStatus {
  return {
    configured,
    signedIn: true,
    email,
    accounts: [{ id: email, email }],
    activeAccountId: email
  }
}

describe('action reconnect result copy', () => {
  it('reports same-account resumed work', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: status(true, 'a@example.com'),
        resumedActions: 2
      })
    ).toBe('Google reconnected — 2 pending changes are retrying.')
  })

  it('does not claim success without OAuth configuration', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: status(false, 'a@example.com'),
        resumedActions: 0
      })
    ).toBe('Google OAuth is not configured — pending changes remain paused.')
  })

  it('does not claim another account resumed the active account queue', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: status(true, 'b@example.com'),
        resumedActions: 0
      })
    ).toBe('Connected as b@example.com — pending changes for a@example.com remain paused.')
  })
})
