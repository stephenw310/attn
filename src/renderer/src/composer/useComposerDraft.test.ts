// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Draft } from '../../../shared/drafts'
import { type ComposerDraftController, useComposerDraft } from './useComposerDraft'

const draft: Draft = {
  id: 'local-draft',
  kind: 'new',
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  bodyHtml: '',
  bodyText: '',
  attachments: [],
  threadId: null,
  sourceMessageId: null,
  inReplyTo: null,
  references: [],
  quoteHtml: '',
  quoteText: '',
  createdAt: 1,
  updatedAt: 1
}

it('does not re-arm a failed autosave after the composer unmounts', async () => {
  vi.useFakeTimers()
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  let rejectSave: (error: Error) => void = () => {}
  const save = vi.fn(
    () =>
      new Promise<{ id: string }>((_resolve, reject) => {
        rejectSave = reject
      })
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { draft: { save, mirror: vi.fn() } } as unknown as Window['attn']
  })

  const container = document.createElement('div')
  const root = createRoot(container)
  let controller: ComposerDraftController | undefined
  function Harness(): null {
    controller = useComposerDraft(draft, () => {})
    return null
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    act(() => controller?.updateFields({ subject: 'dirty' }))
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    rejectSave(new Error('offline'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    vi.advanceTimersByTime(6_000)
    expect(save).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})
