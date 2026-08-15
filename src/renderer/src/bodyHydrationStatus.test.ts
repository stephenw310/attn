import { describe, expect, it } from 'vitest'
import type { MessageBodyState } from '../../shared/mail'
import { bodyHydrationStatusMessage, hydrationAttemptDecision } from './bodyHydrationStatus'

describe('hydrationAttemptDecision', () => {
  it('attempts once per visit and ignores unrelated mail refreshes', () => {
    const input = { account: 'account@example.com', threadId: 'thread-1', readerOpen: true, online: true }
    const first = hydrationAttemptDecision(null, input)
    expect(first.allowHydration).toBe(true)
    expect(hydrationAttemptDecision(first.nextTarget, input).allowHydration).toBe(false)

    const other = hydrationAttemptDecision(first.nextTarget, { ...input, threadId: 'thread-2' })
    expect(other.allowHydration).toBe(true)
    expect(hydrationAttemptDecision(other.nextTarget, input).allowHydration).toBe(true)
  })

  it('resets the attempt after going offline or closing the reader', () => {
    const input = { account: 'account@example.com', threadId: 'thread-1', readerOpen: true, online: true }
    const first = hydrationAttemptDecision(null, input)
    const offline = hydrationAttemptDecision(first.nextTarget, { ...input, online: false })
    expect(offline).toEqual({ allowHydration: false, nextTarget: null })
    expect(hydrationAttemptDecision(offline.nextTarget, input).allowHydration).toBe(true)

    const closed = hydrationAttemptDecision(first.nextTarget, { ...input, readerOpen: false })
    expect(closed).toEqual({ allowHydration: false, nextTarget: null })
    expect(hydrationAttemptDecision(closed.nextTarget, input).allowHydration).toBe(true)
  })
})

describe('bodyHydrationStatusMessage', () => {
  it.each<{
    bodyState: MessageBodyState
    online: boolean
    failed: boolean
    expected: string | undefined
  }>([
    { bodyState: 'complete', online: true, failed: false, expected: undefined },
    { bodyState: 'unavailable', online: true, failed: false, expected: undefined },
    {
      bodyState: 'loading',
      online: false,
      failed: false,
      expected: "Full message loads when you're back online"
    },
    {
      bodyState: 'signed-out',
      online: true,
      failed: false,
      expected: 'Full message loads when signed in'
    },
    { bodyState: 'loading', online: true, failed: true, expected: undefined },
    { bodyState: 'loading', online: true, failed: false, expected: 'Loading full message…' }
  ])('maps $bodyState, online=$online, failed=$failed', ({ bodyState, online, failed, expected }) => {
    expect(bodyHydrationStatusMessage(bodyState, online, failed)).toBe(expected)
  })
})
