import { describe, expect, it } from 'vitest'
import { actionReconnectMessage } from './actionReconnect'

describe('action reconnect result copy', () => {
  it('reports same-account resumed work', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: { configured: true, signedIn: true, email: 'a@example.com' },
        resumedActions: 2
      })
    ).toBe('Google reconnected — 2 pending changes are retrying.')
  })

  it('does not claim success without OAuth configuration', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: { configured: false, signedIn: true, email: 'a@example.com' },
        resumedActions: 0
      })
    ).toBe('Google OAuth is not configured — pending changes remain paused.')
  })

  it('does not claim another account resumed the active account queue', () => {
    expect(
      actionReconnectMessage('a@example.com', {
        status: { configured: true, signedIn: true, email: 'b@example.com' },
        resumedActions: 0
      })
    ).toBe('Connected as b@example.com — pending changes for a@example.com remain paused.')
  })
})
