import { describe, expect, it } from 'vitest'
import type { SplitTriageStatus } from '../../../shared/splits'
import { describeTriageFailures, describeTriageStatus } from './SmartSplitsCard'

function status(overrides: Partial<SplitTriageStatus> = {}): SplitTriageStatus {
  return {
    enabled: true,
    keyPresent: true,
    keyRefused: false,
    describedSplits: 3,
    judgedThreads: 0,
    pendingThreads: 0,
    failedThreads: 0,
    failedCauses: [],
    ...overrides
  }
}

describe('the smart-splits status line', () => {
  it('reports the feature before it reports any number', () => {
    expect(describeTriageStatus(null)).toContain('Off · Write an AI rule')
    expect(describeTriageStatus(status({ enabled: false }))).toContain('Off · Write an AI rule')
    expect(describeTriageStatus(status({ describedSplits: 0 }))).toBe('On · no AI rules yet')
    expect(describeTriageStatus(status({ describedSplits: 1 }))).toBe('On · 1 AI rule')
  })

  it('counts a conversation it gave up on inside the total while judging', () => {
    const judging = status({ judgedThreads: 11_801, pendingThreads: 5, failedThreads: 5 })
    expect(describeTriageStatus(judging)).toBe('On · 3 AI rules · judging 11,801 of 11,811…')
  })

  it('reads a refused key as a pause rather than as progress', () => {
    const refused = status({ keyRefused: true, judgedThreads: 2, pendingThreads: 5 })
    expect(describeTriageStatus(refused)).toBe(
      'On · paused: the TypeSafe key was refused. Save a different key.'
    )
    expect(describeTriageStatus(refused)).not.toContain('judging')
    // The switch still reports the feature first: a refused key is not "on".
    expect(describeTriageStatus(status({ enabled: false, keyRefused: true }))).toContain('Off ·')
  })

  it('names what is left over once nothing is pending', () => {
    expect(describeTriageStatus(status({ judgedThreads: 11_811 }))).toBe('On · 3 AI rules')
    const failed = status({ judgedThreads: 11_801, failedThreads: 10 })
    expect(describeTriageStatus(failed)).toBe('On · 3 AI rules · 10 could not be judged')
  })

  it('explains the failures in the tooltip, and stays quiet without any', () => {
    expect(describeTriageFailures(null)).toBeUndefined()
    expect(describeTriageFailures(status({ judgedThreads: 10 }))).toBeUndefined()
    expect(describeTriageFailures(status({ failedThreads: 1, failedCauses: ['rejected'] }))).toBe(
      '1 conversation could not be judged: the service rejected the request. Retry to ask again.'
    )
    expect(
      describeTriageFailures(status({ failedThreads: 10, failedCauses: ['rate-limited', 'rejected'] }))
    ).toBe(
      '10 conversations could not be judged: the service rate limited the request, ' +
        'the service rejected the request. Retry to ask again.'
    )
    // A cause the pass never recorded leaves the sentence generic.
    expect(describeTriageFailures(status({ failedThreads: 2 }))).toBe(
      '2 conversations could not be judged. Retry to ask again.'
    )
  })
})
