// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { useHighlightedOption, wrappedIndex } from './useHighlightedOption'

test('wraps at both ends and stays put on an empty list', () => {
  expect(wrappedIndex(0, 1, 3)).toBe(1)
  expect(wrappedIndex(2, 1, 3)).toBe(0)
  expect(wrappedIndex(0, -1, 3)).toBe(2)
  expect(wrappedIndex(0, 1, 0)).toBe(0)
  expect(wrappedIndex(5, -1, 0)).toBe(0)
})

test('clamps to the filtered options and keeps one ref callback per option', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  const states: ReturnType<typeof useHighlightedOption>[] = []
  let ids = ['a', 'b', 'c']
  function Harness(): null {
    states.push(useHighlightedOption(ids))
    return null
  }
  const render = async (): Promise<void> => {
    await act(async () => root.render(createElement(Harness)))
  }

  try {
    await render()
    await act(async () => states.at(-1)?.move(-1))
    expect(states.at(-1)?.index).toBe(2)

    // Narrowing the query cannot leave the highlight past the last option.
    ids = ['a']
    await render()
    expect(states.at(-1)?.index).toBe(0)

    // The ref callback is stable per id: an inline one would detach and
    // re-attach every option element on every keystroke.
    const first = states.at(-1)
    if (!first) throw new Error('hook state was not captured')
    const callback = first.optionRef('a')
    await render()
    expect(states.at(-1)?.optionRef('a')).toBe(callback)

    await act(async () => states.at(-1)?.setIndex(0))
    await act(async () => states.at(-1)?.move(1))
    expect(states.at(-1)?.index).toBe(0)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
