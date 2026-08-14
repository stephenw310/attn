import { describe, expect, it } from 'vitest'
import { prunedToVisible, refreshedSelectionIndex } from './selection'

describe('background refresh selection', () => {
  it('preserves the selected thread when new mail reorders the list', () => {
    expect(refreshedSelectionIndex([{ id: 'new' }, { id: 'a' }, { id: 'b' }], 'b', 1)).toBe(2)
  })

  it('keeps the same position when the selected thread leaves the inbox', () => {
    expect(refreshedSelectionIndex([{ id: 'a' }, { id: 'c' }], 'b', 1)).toBe(1)
    expect(refreshedSelectionIndex([], 'b', 1)).toBe(0)
  })
})

describe('pruning ids against the visible list', () => {
  it('drops ids the refresh removed from the list', () => {
    const pruned = prunedToVisible(new Set(['a', 'b']), [{ id: 'b' }, { id: 'c' }])
    expect([...pruned]).toEqual(['b'])
  })

  it('returns the same set when every id is still visible', () => {
    const ids = new Set(['a', 'b'])
    expect(prunedToVisible(ids, [{ id: 'a' }, { id: 'b' }])).toBe(ids)
  })

  it('returns the same empty set without walking the list', () => {
    const ids: ReadonlySet<string> = new Set()
    expect(prunedToVisible(ids, [{ id: 'a' }])).toBe(ids)
  })

  it('empties the set when the list no longer holds any of the ids', () => {
    expect(prunedToVisible(new Set(['a']), []).size).toBe(0)
  })
})
