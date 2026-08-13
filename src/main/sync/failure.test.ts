import { describe, expect, it } from 'vitest'
import { GmailApiError } from '../gmail/client'
import { isOfflineFailure, syncFailureState } from './failure'

describe('sync failure classification', () => {
  it('recognizes fetch failures and nested network error codes as offline', () => {
    expect(isOfflineFailure(new TypeError('fetch failed'))).toBe(true)
    expect(
      isOfflineFailure(Object.assign(new Error('request failed'), { cause: { code: 'ENETUNREACH' } }))
    ).toBe(true)
    expect(syncFailureState(new Error('offline'))).toEqual({ phase: 'offline', message: 'offline' })
  })

  it('keeps Gmail and authentication failures in the error state', () => {
    expect(syncFailureState(new GmailApiError(403, 'quota exceeded', true))).toEqual({
      phase: 'error',
      message: 'quota exceeded'
    })
    expect(syncFailureState(new Error('no refresh token stored — sign in again'))).toEqual({
      phase: 'error',
      message: 'no refresh token stored — sign in again'
    })
  })
})
