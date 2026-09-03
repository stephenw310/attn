// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID, type SplitState } from '../../../shared/splits'
import { useSplits } from './useSplits'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function state(revision: number, ids: readonly string[]): SplitState {
  return {
    revision,
    splits: ids.map((id, index) => ({
      id,
      name: id,
      order: index,
      notify: false,
      total: 0,
      unread: 0,
      preset: null,
      rules: []
    }))
  } as unknown as SplitState
}

test('applies split state by revision and never regresses to an older one', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let resolveGet: ((value: SplitState) => void) | null = null
  const getState = vi.fn(
    () =>
      new Promise<SplitState>((resolve) => {
        resolveGet = resolve
      })
  )
  const save = vi.fn(async () => state(1, [IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID]))
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      splits: { getState, save },
      mail: { onChanged: () => () => {} }
    } as unknown as Window['attn']
  })

  const root = createRoot(document.createElement('div'))
  const states: ReturnType<typeof useSplits>[] = []
  function Harness(): null {
    states.push(useSplits('a@attn.test', OTHER_SPLIT_ID))
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      resolveGet?.(state(3, [IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID]))
      await Promise.resolve()
    })
    // The restored split participates only while nothing newer chose one, and
    // only if the loaded rules still contain it (F18).
    expect(states.at(-1)?.activeSplitId).toBe(OTHER_SPLIT_ID)
    expect(states.at(-1)?.state?.revision).toBe(3)

    // A mutation's response is authoritative, but only forwards: revision 1
    // describes rules older than the ones already applied.
    await act(async () => {
      await states.at(-1)?.save({ id: IMPORTANT_SPLIT_ID, name: 'Important' } as never)
    })
    expect(states.at(-1)?.state?.revision).toBe(3)

    // The same response one revision ahead does apply, and a split that has
    // since been deleted falls back to the default.
    await act(async () => {
      save.mockResolvedValueOnce(state(4, [IMPORTANT_SPLIT_ID]))
      await states.at(-1)?.save({ id: IMPORTANT_SPLIT_ID, name: 'Important' } as never)
    })
    expect(states.at(-1)?.state?.revision).toBe(4)
    expect(states.at(-1)?.activeSplitId).toBe(IMPORTANT_SPLIT_ID)

    // The object identity is stable while nothing about the splits changes:
    // Inbox threads it into the command batch (P1).
    const before = states.at(-1)
    await act(async () => root.render(createElement(Harness)))
    expect(states.at(-1)).toBe(before)
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
