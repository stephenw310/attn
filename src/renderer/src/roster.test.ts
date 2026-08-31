import { describe, expect, it } from 'vitest'
import type { AuthAccount } from '../../shared/auth'
import { orderRoster } from './roster'

const account = (id: string): AuthAccount => ({ id, email: id })

describe('orderRoster', () => {
  it('adopts the response ordering for the accounts the live roster still has', () => {
    const current = [account('a'), account('b'), account('c')]
    const ordered = [account('c'), account('a'), account('b')]
    expect(orderRoster(current, ordered).map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
  })

  it('never resurrects an account removed while the reorder response was in flight', () => {
    const current = [account('a'), account('c')]
    const ordered = [account('c'), account('b'), account('a')]
    expect(orderRoster(current, ordered).map((entry) => entry.id)).toEqual(['c', 'a'])
  })

  it('keeps an account the stale response never heard of, after the ordered ones', () => {
    const current = [account('a'), account('b'), account('d')]
    const ordered = [account('b'), account('a')]
    expect(orderRoster(current, ordered).map((entry) => entry.id)).toEqual(['b', 'a', 'd'])
  })

  it('keeps the live roster objects, not the stale snapshot rows', () => {
    const fresh = { id: 'a', email: 'renamed@example.test' }
    const result = orderRoster([fresh], [account('a')])
    expect(result[0]).toBe(fresh)
  })
})
