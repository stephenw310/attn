import { describe, expect, it, vi } from 'vitest'
import type { MailProvider } from '../sync/provider'
import { executeIntent } from './execute'

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
  })
})
