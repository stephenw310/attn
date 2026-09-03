import { describe, expect, it, vi } from 'vitest'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import {
  classifyActionError,
  executeIntent,
  isPermanentActionError,
  isStoredAuthActionError,
  retryDelayMs,
  storeActionError,
  storedActionErrorKind
} from './execute'

describe('queue intent execution', () => {
  it('routes each intent to the provider endpoint abstraction', async () => {
    const provider = {
      modifyThread: vi.fn(async () => {}),
      trashThread: vi.fn(async () => {}),
      untrashThread: vi.fn(async () => {})
    } satisfies MailActionProvider
    await executeIntent(provider, { kind: 'modifyLabels', threadId: 't1', add: ['STARRED'], remove: [] })
    await executeIntent(provider, { kind: 'trash', threadId: 't2' })
    await executeIntent(provider, { kind: 'untrash', threadId: 't3' })
    expect(provider.modifyThread).toHaveBeenCalledWith('t1', ['STARRED'], [])
    expect(provider.trashThread).toHaveBeenCalledWith('t2')
    expect(provider.untrashThread).toHaveBeenCalledWith('t3')
    expect(provider.modifyThread).toHaveBeenLastCalledWith('t3', ['INBOX'], [])
  })

  it('retries quota failures and advances through the full backoff', () => {
    expect(isPermanentActionError(new GmailApiError(403, 'quota', true))).toBe(false)
    expect(isPermanentActionError(new GmailApiError(400, 'bad request'))).toBe(true)
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([5_000, 30_000, 60_000, 60_000])
  })

  it('classifies retryable, permanent, and auth failures without conflating them', () => {
    expect(classifyActionError(new TypeError('fetch failed'))).toBe('retryable')
    expect(classifyActionError(new GmailApiError(503, 'unavailable', true))).toBe('retryable')
    expect(classifyActionError(new GmailApiError(429, 'quota', true))).toBe('retryable')
    expect(classifyActionError(new GmailApiError(400, 'bad request'))).toBe('permanent')
    expect(classifyActionError(new GmailApiError(403, 'forbidden'))).toBe('permanent')
    expect(classifyActionError(new GmailApiError(404, 'gone'))).toBe('permanent')
    expect(classifyActionError(new GmailApiError(401, 'revoked'))).toBe('auth')
    expect(classifyActionError(new GmailAuthError('token refresh rejected'))).toBe('auth')
  })

  it('recognizes only its own typed auth marker', () => {
    const stored = storeActionError(new GmailApiError(401, 'revoked'), 'auth')
    expect(isStoredAuthActionError(stored)).toBe(true)
    expect(storedActionErrorKind(stored)).toBe('auth')
    expect(storedActionErrorKind(storeActionError(new Error('nope'), 'permanent'))).toBe('permanent')
    // Raw provider text is never a marker: only this executor writes them.
    expect(isStoredAuthActionError('gmail /threads/t-roadmap/modify failed (401): invalid')).toBe(false)
    expect(storedActionErrorKind('gmail /threads/t-roadmap/modify failed (401): invalid')).toBeNull()
  })
})
