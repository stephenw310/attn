import { describe, expect, it, vi } from 'vitest'
import type { ActionRevertNotice, RevertedAction } from '../shared/actionRevert'
import { type ActionRevertTransport, subscribeToActionReverts } from './actionRevertDelivery'

function action(threadId: string): RevertedAction {
  return {
    threadId,
    subject: threadId,
    kind: 'archive',
    returnedToInbox: true,
    resolution: 'restored'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('action revert delivery', () => {
  it('does not acknowledge a notice consumed by a StrictMode-cleaned subscription', async () => {
    const notice: ActionRevertNotice = { id: 1, actions: [action('roadmap')] }
    const firstPeek = deferred<ActionRevertNotice | null>()
    const peek = vi
      .fn()
      .mockReturnValueOnce(firstPeek.promise)
      .mockResolvedValueOnce(notice)
      .mockResolvedValue(null)
    const acknowledge = vi.fn(async () => true)
    const transport: ActionRevertTransport = {
      peek,
      acknowledge,
      onAvailable: () => () => {}
    }
    const first = vi.fn()
    const second = vi.fn()

    const disposeFirst = subscribeToActionReverts('a@example.com', transport, first)
    disposeFirst()
    const disposeSecond = subscribeToActionReverts('a@example.com', transport, second)
    firstPeek.resolve(notice)
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(notice.actions))

    expect(first).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledWith('a@example.com', notice.id)
    disposeSecond()
  })

  it('keeps account identity on both peek and acknowledgement', async () => {
    const notice: ActionRevertNotice = { id: 7, actions: [action('one')] }
    const transport: ActionRevertTransport = {
      peek: vi.fn().mockResolvedValueOnce(notice).mockResolvedValue(null),
      acknowledge: vi.fn(async () => true),
      onAvailable: () => () => {}
    }

    const dispose = subscribeToActionReverts('b@example.com', transport, vi.fn())
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())

    expect(transport.peek).toHaveBeenCalledWith('b@example.com')
    expect(transport.acknowledge).toHaveBeenCalledWith('b@example.com', 7)
    dispose()
  })

  it('stops draining when an acknowledgement loses an account race', async () => {
    const notice: ActionRevertNotice = { id: 9, actions: [action('one')] }
    const transport: ActionRevertTransport = {
      peek: vi.fn(async () => notice),
      acknowledge: vi.fn(async () => false),
      onAvailable: () => () => {}
    }

    const dispose = subscribeToActionReverts('a@example.com', transport, vi.fn())
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())
    await Promise.resolve()

    expect(transport.peek).toHaveBeenCalledOnce()
    dispose()
  })
})
