// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { useSelectionState } from './useSelectionState'

interface Row {
  id: string
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }))
}

test('keeps one callback identity while the focused row moves, and extends by a delta', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  const results: ReturnType<typeof useSelectionState>[] = []
  let selectedIndex = 0
  let visibleRows = rows(4)
  const setSelectedIndex = (next: React.SetStateAction<number>): void => {
    selectedIndex = typeof next === 'function' ? next(selectedIndex) : next
  }

  function Harness(): null {
    results.push(useSelectionState(visibleRows, selectedIndex, setSelectedIndex))
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    const first = results.at(-1)
    if (!first) throw new Error('hook state was not captured')

    // J moves the focused row; the command batch registered on these callbacks
    // must not be torn down and rebuilt for it (P1).
    selectedIndex = 2
    await act(async () => root.render(createElement(Harness)))
    const second = results.at(-1)
    if (!second) throw new Error('hook state was not captured')
    expect(second.extendSelectionBy).toBe(first.extendSelectionBy)
    expect(second.extendSelectionTo).toBe(first.extendSelectionTo)
    expect(second.toggleFocusedSelection).toBe(first.toggleFocusedSelection)
    expect(second.clearSelection).toBe(first.clearSelection)

    // A background refresh replaces the row array; still one identity.
    visibleRows = rows(5)
    await act(async () => root.render(createElement(Harness)))
    const third = results.at(-1)
    if (!third) throw new Error('hook state was not captured')
    expect(third.extendSelectionBy).toBe(first.extendSelectionBy)

    // The stale closure still reads the current index and rows through refs.
    await act(async () => first.extendSelectionBy(1))
    expect(selectedIndex).toBe(3)
    expect([...(results.at(-1)?.selectedIds ?? [])]).toEqual(['row-2', 'row-3'])
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})
