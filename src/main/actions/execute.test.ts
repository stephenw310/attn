import { describe, expect, it, vi } from 'vitest'
import { GmailApiError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'
import { executeIntent, isPermanentActionError, retryDelayMs } from './execute'

describe('queue intent execution', () => {
  it('routes each intent to the provider endpoint abstraction', async () => {
    const provider: MailProvider = {
      modifyThread: vi.fn(async () => {}),
      trashThread: vi.fn(async () => {}),
      untrashThread: vi.fn(async () => {})
    }
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
})
