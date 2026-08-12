import { describe, expect, it } from 'vitest'
import { refreshedSelectionIndex } from './selection'

describe('background refresh selection', () => {
  it('preserves the selected thread when new mail reorders the list', () => {
    expect(refreshedSelectionIndex([{ id: 'new' }, { id: 'a' }, { id: 'b' }], 'b', 1)).toBe(2)
  })

  it('keeps the same position when the selected thread leaves the inbox', () => {
    expect(refreshedSelectionIndex([{ id: 'a' }, { id: 'c' }], 'b', 1)).toBe(1)
    expect(refreshedSelectionIndex([], 'b', 1)).toBe(0)
  })
})
