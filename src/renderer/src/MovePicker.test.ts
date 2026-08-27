// @vitest-environment jsdom

import { act, type ComponentProps, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MailLabel } from '../../shared/mail'
import { MovePicker, type MoveTarget } from './MovePicker'

const labels: MailLabel[] = [
  { id: 'label-project', name: 'Project', type: 'user' },
  { id: 'label-travel', name: 'Travel', type: 'user' }
]
const targets: MoveTarget[] = [
  { id: 'one', labelIds: ['INBOX', 'label-project'], snoozed: false, returned: false }
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
})

async function renderPicker(
  overrides: Partial<ComponentProps<typeof MovePicker>> = {}
): Promise<{ onClose: ReturnType<typeof vi.fn>; onMove: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn()
  const onMove = vi.fn()
  await act(async () => {
    root.render(
      createElement(MovePicker, {
        labels,
        targets,
        sourceLabelId: 'label-project',
        onClose,
        onMove,
        ...overrides
      })
    )
  })
  return { onClose, onMove }
}

function key(input: HTMLInputElement, value: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

describe('MovePicker', () => {
  test('puts Done first, excludes the source label, and filters destinations', async () => {
    await renderPicker()
    const input = container.querySelector('[data-testid="move-search"]') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(container.querySelector('[data-testid="move-done"]')?.textContent).toContain('Done')
    expect(container.querySelector('[data-label-id="label-project"]')).toBeNull()
    expect(container.querySelector('[data-label-id="label-travel"]')).not.toBeNull()

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'no match')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('[data-testid="move-option"]')).toHaveLength(0)
    expect(container.textContent).toContain('No matching labels')
  })

  test('wraps keyboard navigation, moves once, and closes on Escape', async () => {
    const { onClose, onMove } = await renderPicker({ sourceLabelId: null })
    const input = container.querySelector('[data-testid="move-search"]') as HTMLInputElement

    await act(async () => key(input, 'ArrowUp'))
    expect(container.querySelector('[data-label-id="label-travel"]')?.getAttribute('data-highlighted')).toBe(
      'true'
    )
    await act(async () => key(input, 'Enter'))
    expect(onMove).toHaveBeenCalledOnce()
    expect(onMove).toHaveBeenCalledWith('label-travel')

    await act(async () => key(input, 'Escape'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('disables Done only for a complete no-op', async () => {
    await renderPicker({
      labels: [],
      sourceLabelId: null,
      targets: [{ id: 'one', labelIds: ['STARRED'], snoozed: false, returned: false }]
    })
    expect((container.querySelector('[data-testid="move-done"]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      root.render(
        createElement(MovePicker, {
          labels: [],
          targets: [{ id: 'one', labelIds: ['STARRED'], snoozed: true, returned: false }],
          sourceLabelId: null,
          onClose: vi.fn(),
          onMove: vi.fn()
        })
      )
    })
    expect((container.querySelector('[data-testid="move-done"]') as HTMLButtonElement).disabled).toBe(false)
    expect(container.textContent).toContain('Create labels in Gmail')
  })
})
