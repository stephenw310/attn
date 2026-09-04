// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type MailFrameAccessState, useMailFrameAccess } from './mailFrame'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

it('fails closed when message-frame registration rejects', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const registerMessageFrame = vi.fn(async () => {
    throw new Error('registration unavailable')
  })
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      mail: {
        onRemoteImagesChanged: () => () => {},
        registerMessageFrame,
        unregisterMessageFrame: vi.fn(async () => {})
      }
    } as unknown as Window['attn']
  })

  const root = createRoot(document.createElement('div'))
  let state: MailFrameAccessState | undefined
  function Harness(): null {
    state = useMailFrameAccess({ messageId: 'message-1', enabled: true })
    return null
  }

  try {
    await act(async () => {
      root.render(createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(registerMessageFrame).toHaveBeenCalledOnce()
    expect(state?.access).toEqual(expect.objectContaining({ blocked: true, imagesAllowed: false }))
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
