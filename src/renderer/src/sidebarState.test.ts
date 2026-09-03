import { describe, expect, test, vi } from 'vitest'
import { readSidebarCollapsed, SIDEBAR_COLLAPSED_KEY, writeSidebarCollapsed } from './sidebarState'

describe('sidebar state', () => {
  test('defaults to expanded and reads only the stored true value as collapsed', () => {
    expect(readSidebarCollapsed(null)).toBe(false)
    expect(readSidebarCollapsed({ getItem: () => null, setItem: () => {} })).toBe(false)
    expect(readSidebarCollapsed({ getItem: () => 'false', setItem: () => {} })).toBe(false)
    expect(readSidebarCollapsed({ getItem: () => 'true', setItem: () => {} })).toBe(true)
  })

  test('writes the current state and tolerates unavailable storage', () => {
    const setItem = vi.fn()
    writeSidebarCollapsed(true, { getItem: () => null, setItem })
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_KEY, 'true')

    expect(() =>
      writeSidebarCollapsed(false, {
        getItem: () => null,
        setItem: () => {
          throw new Error('blocked')
        }
      })
    ).not.toThrow()
  })
})
