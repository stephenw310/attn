import { describe, expect, it, vi } from 'vitest'
import {
  AccountRoster,
  type AccountRosterOptions,
  type RosterService,
  type RosterTokenStore
} from './accountRoster'
import type { OAuthConfig, TokenSet } from './auth/googleAuth'
import type { StoredAccount } from './auth/tokenFile'
import type { ServiceAccountsState } from './service/protocol'

const CONFIG: OAuthConfig = { client_id: 'client', client_secret: 'secret' }

function account(id: string): StoredAccount {
  return { id, tokens: { email: id, access_token: `token-${id}`, expiry: 0 } as unknown as TokenSet }
}

/** An in-memory token file: the roster's disk writes without the disk. */
function tokenStore(initial: StoredAccount[]): RosterTokenStore & { rows: StoredAccount[] } {
  const state = { rows: [...initial] }
  return {
    get rows() {
      return state.rows
    },
    load: () => [...state.rows],
    save: (_path, tokens) => {
      const id = String((tokens as unknown as { email: string }).email)
      state.rows = [...state.rows.filter((row) => row.id !== id), { id, tokens }]
      return [...state.rows]
    },
    remove: (_path, accountId) => {
      state.rows = state.rows.filter((row) => row.id !== accountId)
      return [...state.rows]
    },
    reorder: (_path, ids) => {
      if (ids.length !== state.rows.length) throw new Error('stale account order')
      state.rows = ids.map((id) => {
        const row = state.rows.find((candidate) => candidate.id === id)
        if (!row) throw new Error('unknown account')
        return row
      })
      return [...state.rows]
    }
  }
}

interface Harness {
  roster: AccountRoster
  store: ReturnType<typeof tokenStore>
  pushed: ServiceAccountsState[]
  service: RosterService & { resolveActive: string | null }
  cancelSignIn: ReturnType<typeof vi.fn>
  adopted: number
}

function harness(
  initial: StoredAccount[],
  overrides: Partial<AccountRosterOptions> = {},
  serviceOverrides: Partial<RosterService> = {}
): Harness {
  const store = tokenStore(initial)
  const pushed: ServiceAccountsState[] = []
  const state = { adopted: 0 }
  const service: RosterService & { resolveActive: string | null } = {
    resolveActive: null,
    applyAccounts: async (accounts) => {
      pushed.push(accounts)
      // The utility answers with the active account it resolved; by default it
      // keeps whatever main asked for.
      return service.resolveActive ?? accounts.activeAccountId
    },
    internal: async () => 0,
    noteActiveAccount: () => {},
    ...serviceOverrides
  }
  const cancelSignIn = vi.fn()
  const roster = new AccountRoster({
    userDataPath: () => '/tmp/roster',
    service: () => service,
    oauthConfig: () => CONFIG,
    reloadOAuthConfig: () => CONFIG,
    signIn: async () => {
      throw new Error('no sign-in in this test')
    },
    cancelSignIn,
    testMode: false,
    onAdopted: () => {
      state.adopted++
    },
    tokenStore: store,
    ...overrides
  })
  roster.loadStoredAccounts()
  return {
    roster,
    store,
    pushed,
    service,
    cancelSignIn,
    get adopted() {
      return state.adopted
    }
  }
}

describe('sign-in', () => {
  it('cancels the flow in flight and only the newest flow clears the marker', async () => {
    const flows: Array<(tokens: TokenSet) => void> = []
    const { roster, cancelSignIn } = harness([], {
      signIn: () => new Promise<TokenSet>((resolve) => flows.push(resolve))
    })

    const first = roster.signIn()
    const second = roster.signIn()
    expect(cancelSignIn).toHaveBeenCalledTimes(1)

    // The replaced flow settling must not clear the marker of the flow that
    // replaced it: the next sign-in still cancels.
    flows[0]?.({ email: 'first@example.test' } as unknown as TokenSet)
    await first
    const third = roster.signIn()
    expect(cancelSignIn).toHaveBeenCalledTimes(2)

    flows[1]?.({ email: 'second@example.test' } as unknown as TokenSet)
    flows[2]?.({ email: 'third@example.test' } as unknown as TokenSet)
    await Promise.all([second, third])
  })

  it('adds an account without activating it and bumps its auth generation', async () => {
    const { roster, pushed } = harness([account('kept@example.test')], {
      signIn: async () => ({ email: 'new@example.test' }) as unknown as TokenSet
    })
    const result = await roster.signIn()
    expect(result.accountId).toBe('new@example.test')
    // The push carries both accounts; activation stays with the utility's answer.
    expect(pushed.at(-1)?.accounts.map((entry) => entry.id)).toEqual([
      'kept@example.test',
      'new@example.test'
    ])
    expect(pushed.at(-1)?.accounts.find((entry) => entry.id === 'new@example.test')?.generation).toBe(1)
    expect(roster.activeId()).toBeNull()
  })
})

describe('removal', () => {
  it('stops the session before the purge and drops the tokens only after it', async () => {
    const order: string[] = []
    const { roster, store } = harness(
      [account('a@example.test'), account('b@example.test')],
      {},
      {
        applyAccounts: async (state) => {
          order.push(`apply:${state.accounts.map((entry) => entry.id).join(',')}`)
          return state.activeAccountId
        },
        internal: async (operation, accountId) => {
          order.push(`${operation}:${String(accountId)}`)
          return 0
        }
      }
    )
    await roster.removeAccount('a@example.test', true)
    expect(order).toEqual(['apply:b@example.test', 'remove-account-data:a@example.test'])
    expect(store.rows.map((row) => row.id)).toEqual(['b@example.test'])
  })

  it('restores the account and keeps its tokens when the purge fails (B23)', async () => {
    const { roster, store } = harness(
      [account('a@example.test'), account('b@example.test')],
      {},
      {
        internal: async (operation) => {
          if (operation === 'remove-account-data') throw new Error('purge failed')
          return 0
        }
      }
    )
    await expect(roster.removeAccount('a@example.test', true)).rejects.toThrow('purge failed')
    expect(roster.authStatus().accounts.map((entry) => entry.id)).toEqual([
      'a@example.test',
      'b@example.test'
    ])
    expect(store.rows.map((row) => row.id)).toEqual(['a@example.test', 'b@example.test'])
  })

  it('restores the roster and session when token deletion fails', async () => {
    const stored = tokenStore([account('a@example.test'), account('b@example.test')])
    const remove = vi.fn((): StoredAccount[] => {
      throw new Error('token delete failed')
    })
    const { roster, pushed } = harness([account('a@example.test'), account('b@example.test')], {
      tokenStore: {
        load: stored.load,
        save: stored.save,
        remove,
        reorder: stored.reorder
      }
    })
    await roster.setActiveAccount('a@example.test')
    pushed.length = 0

    await expect(roster.removeAccount('a@example.test', true)).rejects.toThrow('token delete failed')

    expect(remove).toHaveBeenCalledOnce()
    expect(roster.activeId()).toBe('a@example.test')
    expect(roster.authStatus().accounts.map((entry) => entry.id)).toEqual([
      'a@example.test',
      'b@example.test'
    ])
    expect(pushed.map((state) => state.accounts.map((entry) => entry.id))).toEqual([
      ['b@example.test'],
      ['a@example.test', 'b@example.test']
    ])
  })

  it('activates the account at the removed position and leaves a background removal alone', async () => {
    const { roster, service } = harness([
      account('a@example.test'),
      account('b@example.test'),
      account('c@example.test')
    ])
    service.resolveActive = null
    await roster.setActiveAccount('b@example.test')
    expect(roster.activeId()).toBe('b@example.test')

    // Removing a background account never moves the surface.
    await roster.removeAccount('a@example.test', false)
    expect(roster.activeId()).toBe('b@example.test')

    // Removing the active one activates the next by position.
    await roster.removeAccount('b@example.test', false)
    expect(roster.activeId()).toBe('c@example.test')
  })
})

describe('reorder', () => {
  it('persists the new order and rejects a stale permutation before moving', async () => {
    const { roster, store } = harness([account('a@example.test'), account('b@example.test')])
    await roster.reorderAccounts(['b@example.test', 'a@example.test'])
    expect(roster.authStatus().accounts.map((entry) => entry.id)).toEqual([
      'b@example.test',
      'a@example.test'
    ])
    await expect(roster.reorderAccounts(['b@example.test'])).rejects.toThrow(/stale/)
    expect(store.rows.map((row) => row.id)).toEqual(['b@example.test', 'a@example.test'])
  })
})

function storedToken(store: ReturnType<typeof tokenStore>): string | undefined {
  return (store.rows[0]?.tokens as unknown as { access_token?: string } | undefined)?.access_token
}

describe('token updates', () => {
  it('applies a current refresh and ignores one from a replaced generation', () => {
    const { roster, store } = harness([account('a@example.test')])
    const refreshed = { email: 'a@example.test', access_token: 'fresh' } as unknown as TokenSet
    expect(roster.applyTokenUpdate({ accountId: 'a@example.test', tokens: refreshed, generation: 0 })).toBe(
      true
    )
    expect(storedToken(store)).toBe('fresh')

    const stale = { email: 'a@example.test', access_token: 'stale' } as unknown as TokenSet
    expect(roster.applyTokenUpdate({ accountId: 'a@example.test', tokens: stale, generation: 7 })).toBe(false)
    expect(storedToken(store)).toBe('fresh')
  })
})
