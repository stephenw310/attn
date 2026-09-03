// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { AccountSyncStatus } from '../../../shared/auth'
import { accountNeedsAttention, useAccountHealth } from './useAccountHealth'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function health(accountId: string, phase: string, unread: number): AccountSyncStatus {
  return { accountId, phase, unread } as unknown as AccountSyncStatus
}

test('an attention phase is a reconnect or a hard error', () => {
  expect(accountNeedsAttention(health('a', 'reconnect', 0))).toBe(true)
  expect(accountNeedsAttention(health('a', 'error', 0))).toBe(true)
  expect(accountNeedsAttention(health('a', 'live', 0))).toBe(false)
  expect(accountNeedsAttention(null)).toBe(false)
})

test('an open surface re-reads once, and a later push supersedes that snapshot', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let resolveRead: ((statuses: AccountSyncStatus[]) => void) | null = null
  const getAccountStatuses = vi.fn(
    () =>
      new Promise<AccountSyncStatus[]>((resolve) => {
        resolveRead = resolve
      })
  )
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { auth: { getAccountStatuses } } as unknown as Window['attn']
  })

  const root = createRoot(document.createElement('div'))
  const results: ReturnType<typeof useAccountHealth>[] = []
  let pushed: AccountSyncStatus[] | null = [health('one@attn.test', 'live', 0)]
  let open = false
  function Harness(): null {
    results.push(useAccountHealth(pushed, open))
    return null
  }
  const render = async (): Promise<void> => {
    await act(async () => root.render(createElement(Harness)))
  }

  try {
    await render()
    expect(getAccountStatuses).not.toHaveBeenCalled()
    expect(results.at(-1)?.needsAttention).toBe(false)

    open = true
    await render()
    expect(getAccountStatuses).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveRead?.([health('one@attn.test', 'live', 7)])
      await Promise.resolve()
    })
    // The snapshot's fresher unread count wins over the pushed one.
    expect(results.at(-1)?.healthFor('one@attn.test')?.unread).toBe(7)

    // A push after that snapshot is newer still, and the stale snapshot is
    // dropped because its source no longer matches.
    pushed = [health('one@attn.test', 'reconnect', 0)]
    await render()
    expect(results.at(-1)?.healthFor('one@attn.test')?.phase).toBe('reconnect')
    expect(results.at(-1)?.needsAttention).toBe(true)
    expect(results.at(-1)?.healthFor('missing@attn.test')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
  }
})
