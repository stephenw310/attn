import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { systemTime } from '../time'
import { type HydrationEffects, OnDemandBodyHydrator } from './onDemandBodies'
import type { MailProvider } from './provider'
import { BODY_HYDRATION_TIMEOUT_MS, MAX_RETAINED_BODY_HYDRATION_STATES } from './tuning'

const thread: GmailThread = { id: 'thread-1', messages: [] }

function provider(getThread: MailProvider['getThread']): MailProvider {
  return {
    getThread,
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    listThreadIds: vi.fn(),
    getAttachmentData: vi.fn(),
    listHistory: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
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

function effects(missingMessageIds: HydrationEffects['missingMessageIds']): HydrationEffects {
  return {
    persist: vi.fn(),
    hydrateMissing: vi.fn(async () => {}),
    missingMessageIds
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OnDemandBodyHydrator', () => {
  it('coalesces concurrent requests and broadcasts only when a body becomes complete', async () => {
    const fetched = deferred<GmailThread>()
    const getThread = vi.fn(() => fetched.promise)
    const missingMessageIds = vi
      .fn<HydrationEffects['missingMessageIds']>()
      .mockReturnValueOnce(new Set(['message-1']))
      .mockReturnValueOnce(new Set())
    const hydrationEffects = effects(missingMessageIds)
    const onChanged = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', onChanged, vi.fn(), {
      time: systemTime,
      effects: hydrationEffects
    })
    const mail = provider(getThread)

    const first = hydrator.request('account@example.com', 'thread-1', mail)
    const second = hydrator.request('account@example.com', 'thread-1', mail)
    expect(second).toBe(first)
    expect(hydrator.state('account@example.com', 'thread-1')).toBe('loading')
    expect(getThread).toHaveBeenCalledTimes(1)

    fetched.resolve(thread)
    await first
    expect(getThread).toHaveBeenCalledWith('thread-1', { format: 'full' })
    expect(hydrationEffects.persist).toHaveBeenCalledWith(expect.anything(), 'account@example.com', thread)
    expect(hydrationEffects.hydrateMissing).toHaveBeenCalledWith(
      expect.anything(),
      mail,
      'account@example.com',
      thread,
      expect.any(Function)
    )
    expect(onChanged).toHaveBeenCalledOnce()
    expect(hydrator.state('account@example.com', 'thread-1')).toBe('idle')
  })

  it('marks a coalesced provider request as foreground work exactly once', async () => {
    const fetched = deferred<GmailThread>()
    const trackedAccounts: string[] = []
    const trackProviderWork = async <T>(accountId: string, work: () => Promise<T>): Promise<T> => {
      trackedAccounts.push(accountId)
      return work()
    }
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', vi.fn(), vi.fn(), {
      time: systemTime,
      effects: effects(vi.fn(() => new Set<string>())),
      trackProviderWork
    })
    const mail = provider(vi.fn(() => fetched.promise))

    const first = hydrator.request('account@example.com', 'thread-1', mail)
    const second = hydrator.request('account@example.com', 'thread-1', mail)
    fetched.resolve(thread)
    await Promise.all([first, second])

    expect(trackedAccounts).toEqual(['account@example.com'])
  })

  it('marks a successful bodyless fetch unavailable without broadcasting a mail refresh', async () => {
    const onUnavailable = vi.fn()
    const onChanged = vi.fn()
    const hydrationEffects = effects(vi.fn(() => new Set(['message-1'])))
    const mail = provider(vi.fn(async () => thread))
    const hydrator = new OnDemandBodyHydrator(
      {} as Db,
      () => 'account@example.com',
      onChanged,
      onUnavailable,
      { time: systemTime, effects: hydrationEffects }
    )

    await hydrator.request('account@example.com', 'thread-1', mail)

    expect(onChanged).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledWith('account@example.com', 'thread-1', undefined)
    expect(hydrator.state('account@example.com', 'thread-1')).toBe('unavailable')
  })

  it('bounds retained unavailable states while preserving the most recent attempts', async () => {
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', vi.fn(), vi.fn(), {
      time: systemTime,
      effects: effects(vi.fn(() => new Set(['message-1'])))
    })
    const mail = provider(vi.fn(async (id: string) => ({ id, messages: [] })))

    for (let index = 0; index <= MAX_RETAINED_BODY_HYDRATION_STATES; index++) {
      await hydrator.request('account@example.com', `thread-${index}`, mail)
    }

    expect(hydrator.state('account@example.com', 'thread-0')).toBe('idle')
    expect(hydrator.state('account@example.com', `thread-${MAX_RETAINED_BODY_HYDRATION_STATES}`)).toBe(
      'unavailable'
    )
    hydrator.stop()
  })

  it('broadcasts a partial body change and leaves the unresolved message unavailable', async () => {
    const missingMessageIds = vi
      .fn<HydrationEffects['missingMessageIds']>()
      .mockReturnValueOnce(new Set(['message-1', 'message-2']))
      .mockReturnValueOnce(new Set(['message-2']))
    const onChanged = vi.fn()
    const onUnavailable = vi.fn()
    const hydrator = new OnDemandBodyHydrator(
      {} as Db,
      () => 'account@example.com',
      onChanged,
      onUnavailable,
      { time: systemTime, effects: effects(missingMessageIds) }
    )

    await hydrator.request('account@example.com', 'thread-1', provider(vi.fn(async () => thread)))

    expect(onChanged).toHaveBeenCalledOnce()
    expect(onUnavailable).toHaveBeenCalledWith('account@example.com', 'thread-1', undefined)
    expect(hydrator.state('account@example.com', 'thread-1')).toBe('unavailable')
  })

  it('settles failures quietly and allows the next explicit request to retry', async () => {
    const getThread = vi
      .fn<MailProvider['getThread']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(thread)
    const missingMessageIds = vi
      .fn<HydrationEffects['missingMessageIds']>()
      .mockReturnValueOnce(new Set(['message-1']))
      .mockReturnValueOnce(new Set(['message-1']))
      .mockReturnValueOnce(new Set(['message-1']))
      .mockReturnValueOnce(new Set())
    const onUnavailable = vi.fn()
    const onChanged = vi.fn()
    const hydrator = new OnDemandBodyHydrator(
      {} as Db,
      () => 'account@example.com',
      onChanged,
      onUnavailable,
      { time: systemTime, effects: effects(missingMessageIds) }
    )
    const mail = provider(getThread)

    await hydrator.request('account@example.com', 'thread-1', mail)
    expect(onUnavailable).toHaveBeenCalledWith('account@example.com', 'thread-1', expect.any(Error))
    expect(onChanged).not.toHaveBeenCalled()

    await hydrator.request('account@example.com', 'thread-1', mail)
    expect(getThread).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('does not persist a response after the active account changes', async () => {
    const fetched = deferred<GmailThread>()
    let account: string | null = 'account@example.com'
    const hydrationEffects = effects(vi.fn(() => new Set(['message-1'])))
    const onChanged = vi.fn()
    const onUnavailable = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => account, onChanged, onUnavailable, {
      time: systemTime,
      effects: hydrationEffects
    })
    const attempt = hydrator.request(
      'account@example.com',
      'thread-1',
      provider(vi.fn(() => fetched.promise))
    )

    account = 'other@example.com'
    fetched.resolve(thread)
    await attempt

    expect(hydrationEffects.persist).not.toHaveBeenCalled()
    expect(hydrationEffects.hydrateMissing).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(onUnavailable).not.toHaveBeenCalled()
  })

  it('cancels an active attempt before shutdown can close the database', async () => {
    const fetched = deferred<GmailThread>()
    const hydrationEffects = effects(vi.fn(() => new Set(['message-1'])))
    const onChanged = vi.fn()
    const onUnavailable = vi.fn()
    const hydrator = new OnDemandBodyHydrator(
      {} as Db,
      () => 'account@example.com',
      onChanged,
      onUnavailable,
      { time: systemTime, effects: hydrationEffects }
    )
    const attempt = hydrator.request(
      'account@example.com',
      'thread-1',
      provider(vi.fn(() => fetched.promise))
    )

    hydrator.stop()
    await attempt
    fetched.resolve(thread)
    await Promise.resolve()

    expect(hydrationEffects.persist).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(onUnavailable).not.toHaveBeenCalled()
  })

  it('times out a hung fetch and releases the thread for a later retry', async () => {
    vi.useFakeTimers()
    const getThread = vi.fn<MailProvider['getThread']>(() => new Promise(() => {}))
    const onUnavailable = vi.fn()
    const hydrator = new OnDemandBodyHydrator({} as Db, () => 'account@example.com', vi.fn(), onUnavailable, {
      time: systemTime,
      effects: effects(vi.fn(() => new Set(['message-1'])))
    })
    const mail = provider(getThread)

    const attempt = hydrator.request('account@example.com', 'thread-1', mail)
    await vi.advanceTimersByTimeAsync(BODY_HYDRATION_TIMEOUT_MS)
    await attempt

    expect(onUnavailable).toHaveBeenCalledWith('account@example.com', 'thread-1', expect.any(Error))
    expect(hydrator.state('account@example.com', 'thread-1')).toBe('unavailable')
    void hydrator.request('account@example.com', 'thread-1', mail)
    expect(getThread).toHaveBeenCalledTimes(2)
    hydrator.stop()
  })
})
