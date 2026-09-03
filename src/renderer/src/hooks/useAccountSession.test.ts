// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { AuthStatus } from '../../../shared/auth'
import { readAccountView, saveAccountView } from '../accountViewMemory'
import { useAccountSession } from './useAccountSession'

const attnDescriptor = Object.getOwnPropertyDescriptor(window, 'attn')

afterEach(() => {
  if (attnDescriptor) Object.defineProperty(window, 'attn', attnDescriptor)
  else Reflect.deleteProperty(window, 'attn')
})

function status(activeAccountId: string): AuthStatus {
  return {
    signedIn: true,
    email: activeAccountId,
    activeAccountId,
    accounts: [
      { id: 'one@attn.test', email: 'one@attn.test' },
      { id: 'two@attn.test', email: 'two@attn.test' }
    ]
  } as AuthStatus
}

async function mount(bridge: Record<string, unknown> = {}) {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const auth = {
    signIn: vi.fn(),
    setActiveAccount: vi.fn(async (id: string) => status(id)),
    removeAccount: vi.fn(async () => status('two@attn.test')),
    getStatus: vi.fn(async () => status('two@attn.test')),
    onAccountStatuses: vi.fn(() => () => {}),
    getAccountStatuses: vi.fn(async () => []),
    ...bridge
  }
  Object.defineProperty(window, 'attn', {
    configurable: true,
    value: { auth } as unknown as Window['attn']
  })
  const toasts: string[] = []
  const removalErrors: string[] = []
  const statuses: AuthStatus[] = []
  const composerOpen = { current: false }
  const saveAccountSnapshot = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const sessions: ReturnType<typeof useAccountSession>[] = []
  function Harness(): React.ReactNode {
    const session = useAccountSession({
      status: status('one@attn.test'),
      onStatus: (next) => statuses.push(next),
      onRemovalError: (message) => removalErrors.push(message),
      showToast: async (message) => {
        toasts.push(message)
      },
      composerOpen,
      composerOpening: { current: false },
      saveAccountSnapshot
    })
    sessions.push(session)
    return session.removeAccountDialog
  }
  await act(async () => root.render(createElement(Harness)))
  return {
    auth,
    toasts,
    removalErrors,
    statuses,
    composerOpen,
    saveAccountSnapshot,
    container,
    session: () => sessions.at(-1) as ReturnType<typeof useAccountSession>,
    click: async (testId: string) => {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      if (!button) throw new Error(`missing ${testId}`)
      await act(async () => button.click())
    },
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
    }
  }
}

test('a switch saves this account view first and refuses while a composer is open', async () => {
  const harness = await mount()
  try {
    await act(async () => harness.session().switchAccount('two@attn.test'))
    expect(harness.saveAccountSnapshot).toHaveBeenCalledTimes(1)
    expect(harness.auth.setActiveAccount).toHaveBeenCalledWith('two@attn.test')
    expect(harness.statuses.at(-1)?.activeAccountId).toBe('two@attn.test')
    expect(harness.session().accountSwitchPending).toBe(false)

    // Switching to the account already active is a no-op, not a round trip.
    await act(async () => harness.session().switchAccount('one@attn.test'))
    expect(harness.auth.setActiveAccount).toHaveBeenCalledTimes(1)

    harness.composerOpen.current = true
    await act(async () => harness.session().switchAccount('two@attn.test'))
    expect(harness.auth.setActiveAccount).toHaveBeenCalledTimes(1)
    expect(harness.toasts).toEqual(['Save and close the draft before switching accounts'])
  } finally {
    await harness.unmount()
  }
})

test('confirmed removal drops the account view memory', async () => {
  saveAccountView('one@attn.test', { view: 'inbox', splitId: null, viewRecords: [], splitRecords: [] })
  const harness = await mount()
  try {
    await act(async () => harness.session().requestRemoveAccount())
    expect(harness.session().removeAccountOpen).toBe(true)
    await harness.click('remove-account-delete')
    expect(harness.auth.removeAccount).toHaveBeenCalledWith('one@attn.test', true)
    expect(readAccountView('one@attn.test')).toBeNull()
    expect(harness.statuses.at(-1)?.activeAccountId).toBe('two@attn.test')
    expect(harness.session().removeAccountOpen).toBe(false)
  } finally {
    await harness.unmount()
  }
})

test('a failed removal reports it above the tree and re-pulls the status', async () => {
  const harness = await mount({
    removeAccount: vi.fn(async () => {
      throw new Error('nope')
    })
  })
  try {
    await act(async () => harness.session().requestRemoveAccount())
    await harness.click('remove-account-keep')
    expect(harness.removalErrors.at(-1)).toContain('Could not remove the account one@attn.test')
    expect(harness.auth.getStatus).toHaveBeenCalledTimes(1)
    expect(harness.session().accountSwitchPending).toBe(false)
  } finally {
    await harness.unmount()
  }
})

test('the roster seed never overwrites a push that already landed', async () => {
  let push: ((statuses: unknown[]) => void) | null = null
  let resolveSeed: ((statuses: unknown[]) => void) | null = null
  const harness = await mount({
    onAccountStatuses: vi.fn((listener: (statuses: unknown[]) => void) => {
      push = listener
      return () => {}
    }),
    getAccountStatuses: vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSeed = resolve as (statuses: unknown[]) => void
        })
    )
  })
  try {
    await act(async () => {
      push?.([{ accountId: 'one@attn.test', phase: 'reconnect', unread: 1 }])
    })
    expect(harness.session().accountStatuses?.[0]).toMatchObject({ phase: 'reconnect' })

    await act(async () => {
      resolveSeed?.([{ accountId: 'one@attn.test', phase: 'live', unread: 0 }])
      await Promise.resolve()
    })
    expect(harness.session().accountStatuses?.[0]).toMatchObject({ phase: 'reconnect' })
  } finally {
    await harness.unmount()
  }
})
