import { describe, expect, it } from 'vitest'
import { inboxZeroRotation } from './InboxZero'

describe('inboxZeroRotation', () => {
  it('keeps one image for the local day and advances on the next date', () => {
    const morning = inboxZeroRotation(new Date(2026, 7, 29, 0, 1))
    const evening = inboxZeroRotation(new Date(2026, 7, 29, 23, 59))
    const nextDay = inboxZeroRotation(new Date(2026, 7, 30, 0, 1))

    expect(evening).toBe(morning)
    expect(nextDay).toBe((morning + 1) % 3)
  })
})
