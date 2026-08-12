import { describe, expect, it } from 'vitest'
import { dateGroup } from './dateGroup'

describe('dateGroup', () => {
  const now = new Date(2026, 7, 12, 12)
  const atDaysAgo = (days: number): number => new Date(2026, 7, 12 - days, 9).getTime()

  it('groups production timestamps relative to an injected current date', () => {
    expect(dateGroup({ lastMsgAt: atDaysAgo(0), at: '' }, now)).toBe('Today')
    expect(dateGroup({ lastMsgAt: atDaysAgo(1), at: '' }, now)).toBe('Yesterday')
    expect(dateGroup({ lastMsgAt: atDaysAgo(6), at: '' }, now)).toBe('Last 7 days')
    expect(dateGroup({ lastMsgAt: atDaysAgo(7), at: '' }, now)).toBe('Earlier this month')
    expect(dateGroup({ lastMsgAt: new Date(2026, 6, 31).getTime(), at: '' }, now)).toBe('Older')
  })
})
