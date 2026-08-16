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

const alwaysVisible = {
  isVisible: () => true,
  onVisibilityChange: () => () => {}
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
      onAvailable: () => () => {},
      ...alwaysVisible
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
      onAvailable: () => () => {},
      ...alwaysVisible
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
      onAvailable: () => () => {},
      ...alwaysVisible
    }

    const dispose = subscribeToActionReverts('a@example.com', transport, vi.fn())
    await vi.waitFor(() => expect(transport.acknowledge).toHaveBeenCalledOnce())
    await Promise.resolve()

    expect(transport.peek).toHaveBeenCalledOnce()
    dispose()
  })

  it('waits for each rendered batch before acknowledging and delivering the next one', async () => {
    const notices: ActionRevertNotice[] = [
      { id: 10, actions: [action('one')] },
      { id: 11, actions: [action('two')] }
    ]
    const firstDisplayed = deferred<void>()
    const callback = vi
      .fn<(actions: RevertedAction[]) => void | Promise<void>>()
      .mockReturnValueOnce(firstDisplayed.promise)
    const acknowledge = vi.fn(async (_accountId: string, noticeId: number) => {
      if (notices[0]?.id !== noticeId) return false
      notices.shift()
      return true
    })
    const transport: ActionRevertTransport = {
      peek: vi.fn(async () => notices[0] ?? null),
      acknowledge,
      onAvailable: () => () => {},
      ...alwaysVisible
    }

    const dispose = subscribeToActionReverts('a@example.com', transport, callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(acknowledge).not.toHaveBeenCalled()

    firstDisplayed.resolve(undefined)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2))
    expect(callback.mock.calls.map(([actions]) => actions[0]?.threadId)).toEqual(['one', 'two'])
    dispose()
  })

  it('leaves a notice buffered while the window is hidden and delivers it on show', async () => {
    const notice: ActionRevertNotice = { id: 1, actions: [action('roadmap')] }
    const buffered: ActionRevertNotice[] = [notice]
    const acknowledge = vi.fn(async (_accountId: string, noticeId: number) => {
      if (buffered[0]?.id !== noticeId) return false
      buffered.shift()
      return true
    })
    let visible = false
    let onShown = (): void => {}
    const transport: ActionRevertTransport = {
      peek: vi.fn(async () => buffered[0] ?? null),
      acknowledge,
      onAvailable: () => () => {},
      isVisible: () => visible,
      onVisibilityChange: (listener) => {
        onShown = listener
        return () => {}
      }
    }
    const callback = vi.fn()

    // A background launch mounts a renderer inside an invisible window; a toast
    // shown there would be acknowledged without anyone seeing it.
    const dispose = subscribeToActionReverts('a@example.com', transport, callback)
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()

    visible = true
    onShown()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(notice.actions))
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith('a@example.com', 1))
    dispose()
  })
})
