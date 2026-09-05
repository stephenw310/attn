// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { UPDATE_STATE_IDLE, type UpdateState } from '../../../shared/distribution'
import { useAppUpdate } from './useAppUpdate'

it('keeps newer pushed state when an initial read or manual check answers late', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  let resolveSnapshot!: (state: UpdateState) => void
  let resolveCheck!: (state: UpdateState) => void
  const snapshot = new Promise<UpdateState>((resolve) => {
    resolveSnapshot = resolve
  })
  const check = new Promise<UpdateState>((resolve) => {
    resolveCheck = resolve
  })
  let push!: (state: UpdateState) => void
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      app: { getInfo: async () => null },
      update: {
        getState: () => snapshot,
        check: () => check,
        onState: (listener: typeof push) => {
          push = listener
          return unsubscribe
        }
      }
    }
  })
  let current!: ReturnType<typeof useAppUpdate>
  function Harness(): null {
    current = useAppUpdate()
    return null
  }
  const root = createRoot(document.createElement('div'))
  const ready: UpdateState = { ...UPDATE_STATE_IDLE, phase: 'ready', readyVersion: '2.0.0' }
  try {
    await act(async () => root.render(createElement(Harness)))
    const response = current.check()
    await act(async () => push(ready))
    await act(async () => {
      resolveSnapshot(UPDATE_STATE_IDLE)
      resolveCheck(UPDATE_STATE_IDLE)
      await response
    })
    expect(current.state).toEqual(ready)
    expect(await response).toEqual(UPDATE_STATE_IDLE)
  } finally {
    await act(async () => root.unmount())
    if (descriptor) Object.defineProperty(window, 'attn', descriptor)
    else Reflect.deleteProperty(window, 'attn')
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
})
