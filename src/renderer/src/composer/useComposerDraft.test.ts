// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Draft } from '../../../shared/drafts'
import { MIRROR_IDLE_MS, MIRROR_PAYLOAD_IDLE_MS } from '../../../shared/outboxTuning'
import { type ComposerDraftController, mirrorIdleMs, useComposerDraft } from './useComposerDraft'

const draft: Draft = {
  id: 'local-draft',
  accountId: 'user@attn.test',
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
  followUpAt: null,
  createdAt: 1,
  updatedAt: 1
}

const file = (sizeBytes: number) => ({
  id: `attachment-${sizeBytes}`,
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes
})

it('slows the mirror only once a draft carries real attachment payload', () => {
  expect(mirrorIdleMs([])).toBe(MIRROR_IDLE_MS)
  expect(mirrorIdleMs([file(64_000)])).toBe(MIRROR_IDLE_MS)
  expect(mirrorIdleMs([file(4_000_000)])).toBe(MIRROR_PAYLOAD_IDLE_MS)
  expect(mirrorIdleMs([file(600_000), file(600_000)])).toBe(MIRROR_PAYLOAD_IDLE_MS)
})

it('pushes an attachment change promptly but lets body edits wait', async () => {
  vi.useFakeTimers()
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')
  const mirror = vi.fn(async () => {})
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: {
      draft: { save: vi.fn(async () => ({ id: 'local-draft' })), mirror }
    } as unknown as Window['attn']
  })

  const container = document.createElement('div')
  const root = createRoot(container)
  let controller: ComposerDraftController | undefined
  function Harness(): null {
    controller = useComposerDraft(draft, () => {})
    return null
  }

  const settle = async (ms: number): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  try {
    await act(async () => root.render(createElement(Harness)))

    // Attaching a large file mirrors on the short interval.
    act(() => controller?.updateFields({ attachments: [file(4_000_000)] }))
    await settle(MIRROR_IDLE_MS)
    expect(mirror).toHaveBeenCalledOnce()

    // A later body edit on that now-heavy draft waits for the longer one.
    act(() => controller?.updateFields({ subject: 'edited' }))
    await settle(MIRROR_IDLE_MS)
    expect(mirror).toHaveBeenCalledOnce()
    await settle(MIRROR_PAYLOAD_IDLE_MS - MIRROR_IDLE_MS)
    expect(mirror).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
    else Reflect.deleteProperty(window, 'attn')
  }
})

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
