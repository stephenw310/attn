import { describe, expect, it } from 'vitest'
import { accountSyncPhase, isSignInCanceled, signInErrorMessage } from './auth'

describe('accountSyncPhase', () => {
  it('maps each sync phase to the menu one-liner', () => {
    expect(accountSyncPhase({ phase: 'idle' }, false)).toBe('live')
    expect(accountSyncPhase({ phase: 'checking' }, false)).toBe('syncing')
    expect(accountSyncPhase({ phase: 'syncing', stage: 'metadata', threadsDone: 3 }, false)).toBe('syncing')
    expect(
      accountSyncPhase({ phase: 'indexing', stage: 'lifetime', threadsDone: 9, reason: 'running' }, false)
    ).toBe('syncing')
    expect(accountSyncPhase({ phase: 'offline', message: 'net down' }, false)).toBe('offline')
    expect(accountSyncPhase({ phase: 'error', message: 'boom' }, false)).toBe('error')
  })

  it('lets an auth-paused queue outrank every sync phase', () => {
    // The account needs the user; any other word would hide that behind a
    // switch (F18 — background failures must be discoverable from the menu).
    expect(accountSyncPhase({ phase: 'idle' }, true)).toBe('reconnect')
    expect(accountSyncPhase({ phase: 'offline', message: 'net down' }, true)).toBe('reconnect')
  })
})

describe('signInErrorMessage', () => {
  it('strips the Electron invoke wrapper the bridge adds to a rejection', () => {
    const wrapped = new Error(
      "Error invoking remote method 'auth:signIn': Error: state mismatch in OAuth callback"
    )
    expect(signInErrorMessage(wrapped, 'Could not sign in.')).toBe('state mismatch in OAuth callback')
  })

  it('leaves an unwrapped main-process message alone', () => {
    const direct = new Error('sign-in timed out — no response from the browser within 5 minutes')
    expect(signInErrorMessage(direct, 'Could not sign in.')).toBe(
      'sign-in timed out — no response from the browser within 5 minutes'
    )
  })

  it('drops every nested Error prefix', () => {
    const nested = new Error(
      "Error invoking remote method 'auth:signIn': Error: Error: TypeError: sign-in could not open a loopback listener: EACCES"
    )
    expect(signInErrorMessage(nested, 'Could not sign in.')).toBe(
      'sign-in could not open a loopback listener: EACCES'
    )
  })

  it('rewrites a denied consent into an instruction the user can follow', () => {
    const denied = new Error(
      "Error invoking remote method 'auth:signIn': Error: Google returned error: access_denied"
    )
    expect(signInErrorMessage(denied, 'Could not sign in.')).toBe(
      'Google did not grant access. Try again and allow the requested permissions.'
    )
  })

  it('falls back when the rejection is not an Error and when it carries no text', () => {
    expect(signInErrorMessage({ code: 500 }, 'Could not sign in.')).toBe('Could not sign in.')
    expect(signInErrorMessage(undefined, 'Could not reconnect Google')).toBe('Could not reconnect Google')
    expect(signInErrorMessage(new Error("Error invoking remote method 'auth:signIn': Error:"), 'x')).toBe('x')
  })

  it('keeps a canceled sign-in detectable through the wrapper', () => {
    expect(
      isSignInCanceled(new Error("Error invoking remote method 'auth:signIn': Error: sign-in canceled"))
    ).toBe(true)
  })
})
