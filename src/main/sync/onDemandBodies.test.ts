import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { OnDemandBodyHydrator } from './onDemandBodies'
import type { MailProvider } from './provider'

const thread: GmailThread = { id: 'thread-1', messages: [] }

function provider(getThread: MailProvider['getThread']): MailProvider {
  return {
    getThread,
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    listThreadIds: vi.fn(),
    getAttachmentData: vi.fn(),
    listHistory: vi.fn(),
    modifyThread: vi.fn(),
    trashThread: vi.fn(),
    untrashThread: vi.fn()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('OnDemandBodyHydrator', () => {
  it('coalesces concurrent requests for the same account and thread', async () => {
    const fetched = deferred<GmailThread>()
    const getThread = vi.fn(() => fetched.promise)
    const persist = vi.fn()
    const hydrateMissing = vi.fn(async () => {})
    const onChanged = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', onChanged, vi.fn(), {
      persist,
      hydrateMissing
    })
    const mail = provider(getThread)

    const first = hydrator.request('account@example.com', 'thread-1', mail)
    const second = hydrator.request('account@example.com', 'thread-1', mail)
    expect(second).toBe(first)
    expect(getThread).toHaveBeenCalledTimes(1)

    fetched.resolve(thread)
    await first
    expect(getThread).toHaveBeenCalledWith('thread-1', { format: 'full' })
    expect(persist).toHaveBeenCalledWith(expect.anything(), 'account@example.com', thread)
    expect(hydrateMissing).toHaveBeenCalledWith(expect.anything(), mail, 'account@example.com', thread)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('settles failures silently and allows the next request to retry', async () => {
    const getThread = vi
      .fn<MailProvider['getThread']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(thread)
    const onFailed = vi.fn()
    const onChanged = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', onChanged, onFailed, {
      persist: vi.fn(),
      hydrateMissing: vi.fn(async () => {})
    })
    const mail = provider(getThread)

    await hydrator.request('account@example.com', 'thread-1', mail)
    expect(onFailed).toHaveBeenCalledWith('account@example.com', 'thread-1', expect.any(Error))
    expect(onChanged).not.toHaveBeenCalled()

    await hydrator.request('account@example.com', 'thread-1', mail)
    expect(getThread).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('does not persist a response after the active account changes', async () => {
    const fetched = deferred<GmailThread>()
    let account: string | null = 'account@example.com'
    const persist = vi.fn()
    const hydrateMissing = vi.fn(async () => {})
    const onChanged = vi.fn()
    const onFailed = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => account, onChanged, onFailed, {
      persist,
      hydrateMissing
    })
    const attempt = hydrator.request(
      'account@example.com',
      'thread-1',
      provider(vi.fn(() => fetched.promise))
    )

    account = 'other@example.com'
    fetched.resolve(thread)
    await attempt

    expect(persist).not.toHaveBeenCalled()
    expect(hydrateMissing).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })
})
