// The account roster: who is signed in, in what order, which one is active,
// and every transition between those states (F15/F18, D3). It owns the token
// file, the per-account auth generation, and the interactive sign-in's
// cancellation generation, and it is the only writer of that state — main's
// entry point boots windows and tears them down (R11).
//
// Every mutation ends by pushing the roster to the utility and adopting the
// active account the utility resolved: that answer is what makes an AuthStatus
// truthful, because the named account's session provably exists by then.

import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import { errorMessage } from '../shared/error'
import type { OAuthConfig, TokenSet } from './auth/googleAuth'
import { accountIdForTokens, reorderIds, type StoredAccount } from './auth/tokenFile'
import { loadAccounts, removeAccountTokens, reorderAccountTokens, saveAccountTokens } from './auth/tokenStore'
import { isCurrentTokenUpdate } from './auth/tokenUpdate'
import type { ServiceAccountsState, ServiceOperation, ServiceReady } from './service/protocol'

/** The token file, injectable so the roster's transitions unit-test on disk-free fakes. */
export interface RosterTokenStore {
  load: (userDataPath: string) => StoredAccount[]
  save: (userDataPath: string, tokens: TokenSet, roster?: readonly StoredAccount[]) => StoredAccount[]
  remove: (userDataPath: string, accountId: string) => StoredAccount[]
  reorder: (userDataPath: string, ids: readonly string[]) => StoredAccount[]
}

/** The slice of the utility supervisor the roster drives. */
export interface RosterService {
  applyAccounts: (state: ServiceAccountsState) => Promise<unknown>
  internal: (operation: ServiceOperation, ...args: unknown[]) => Promise<unknown>
  noteActiveAccount: (activeAccountId: string | null) => void
}

export interface TokenUpdateEvent {
  accountId: string
  tokens: TokenSet
  generation: number
}

export interface AccountRosterOptions {
  userDataPath: () => string
  /** Null before the utility is up and after teardown. */
  service: () => RosterService | null
  /** The cached OAuth client; a sign-in reloads it first. */
  oauthConfig: () => OAuthConfig | null
  reloadOAuthConfig: () => OAuthConfig | null
  signIn: (config: OAuthConfig) => Promise<TokenSet>
  cancelSignIn: () => void
  /** Seeded e2e runs carry their roster in the utility, not the token file. */
  testMode: boolean
  /** Runs after every adopted roster push (pending focus, notifier roster). */
  onAdopted: (status: AuthStatus) => void
  tokenStore?: RosterTokenStore
}

const REAL_TOKEN_STORE: RosterTokenStore = {
  load: loadAccounts,
  save: saveAccountTokens,
  remove: removeAccountTokens,
  reorder: reorderAccountTokens
}

export class AccountRoster {
  private storedAccounts: StoredAccount[] = []
  private seedAccountIds: string[] = []
  private activeAccountId: string | null = null
  private readonly authGenerations = new Map<string, number>()
  // Each interactive sign-in takes a generation; a later call cancels the flow
  // in flight, and only the newest flow may clear the marker — a boolean let a
  // canceled flow's `finally` clear the flag of the flow that replaced it.
  private signInGeneration = 0
  private activeSignInGeneration = 0
  private readonly tokens: RosterTokenStore

  constructor(private readonly options: AccountRosterOptions) {
    this.tokens = options.tokenStore ?? REAL_TOKEN_STORE
  }

  /** Read the token file at boot, before the utility is constructed. */
  loadStoredAccounts(): StoredAccount[] {
    this.storedAccounts = this.tokens.load(this.options.userDataPath())
    for (const account of this.storedAccounts) {
      if (!this.authGenerations.has(account.id)) this.authGenerations.set(account.id, 0)
    }
    return this.storedAccounts
  }

  /**
   * Mirror the roster the utility resolved at boot — seed sessions included,
   * plus the persisted active pointer — rather than re-deriving it here.
   */
  adoptReady(ready: ServiceReady, seeded: boolean): void {
    this.seedAccountIds = seeded
      ? ready.accountIds.filter((id) => !this.storedAccounts.some((account) => account.id === id))
      : []
    this.activeAccountId = ready.activeAccountId
    this.options.service()?.noteActiveAccount(this.activeAccountId)
  }

  activeId(): string | null {
    return this.activeAccountId
  }

  accountIds(): string[] {
    return this.seedAccountIds.length > 0 ? this.seedAccountIds : this.storedAccounts.map(({ id }) => id)
  }

  private emailFor(accountId: string): string {
    const stored = this.storedAccounts.find((account) => account.id === accountId)
    return stored?.tokens.email ?? accountId
  }

  authStatus(): AuthStatus {
    const accounts = this.accountIds().map((id) => ({ id, email: this.emailFor(id) }))
    const active = accounts.find((account) => account.id === this.activeAccountId) ?? null
    return {
      configured: this.seedAccountIds.length === 0 && this.options.oauthConfig() !== null,
      signedIn: accounts.length > 0,
      ...(active ? { email: active.email } : {}),
      accounts,
      activeAccountId: active?.id ?? null
    }
  }

  serviceAccountsState(): ServiceAccountsState {
    return {
      config: this.options.oauthConfig(),
      accounts: this.storedAccounts.map((account) => ({
        id: account.id,
        tokens: account.tokens,
        generation: this.authGenerations.get(account.id) ?? 0
      })),
      activeAccountId: this.activeAccountId,
      ...(this.options.testMode ? { seedAccountIds: this.seedAccountIds } : {})
    }
  }

  async signIn(): Promise<AuthSignInResult> {
    const config = this.options.reloadOAuthConfig()
    if (!config) {
      const resumedActions = Number((await this.options.service()?.internal('resume-auth-failures')) ?? 0)
      return { status: this.authStatus(), resumedActions }
    }
    if (this.activeSignInGeneration !== 0) this.options.cancelSignIn()
    const generation = ++this.signInGeneration
    this.activeSignInGeneration = generation
    let resumedActions = 0
    let signedInAccountId: string | undefined
    try {
      const tokens = await this.options.signIn(config)
      const accountId = accountIdForTokens(tokens)
      if (!accountId) throw new Error('Google did not return an email address for this account')
      const refreshed = this.storedAccounts.some((account) => account.id === accountId)
      this.storedAccounts = this.tokens.save(this.options.userDataPath(), tokens)
      this.authGenerations.set(accountId, (this.authGenerations.get(accountId) ?? 0) + 1)
      signedInAccountId = accountId
      // Adding an account does not activate it: activation goes through the
      // guarded renderer switch, so an OAuth completion that lands while a
      // composer is open can never swap the surface (PR #94 review). The roster
      // update is awaited — the utility's answer names the sessions that
      // actually exist, deferred re-creates included — and its resolved active
      // account (the first sign-in, or the persisted survivor) is adopted.
      await this.adoptServiceAccounts()
      // Resume the account the flow actually reauthenticated — not the active
      // one, which sign-in no longer changes.
      resumedActions = Number(
        (await this.options.service()?.internal('resume-auth-failures', accountId)) ?? 0
      )
      console.log(`[auth] ${refreshed ? 'reconnected' : 'added account'} ${tokens.email ?? accountId}`)
    } catch (error) {
      console.error(`[auth] sign-in failed: ${errorMessage(error)}`)
      throw error
    } finally {
      if (this.activeSignInGeneration === generation) this.activeSignInGeneration = 0
    }
    return {
      status: this.authStatus(),
      resumedActions,
      ...(signedInAccountId ? { accountId: signedInAccountId } : {})
    }
  }

  /**
   * Push the roster to the utility and mirror back the active account it
   * resolved. Waiting on the response is what keeps AuthStatus truthful: the
   * named active account's session exists before anyone reads it.
   */
  async adoptServiceAccounts(): Promise<void> {
    const service = this.options.service()
    const result = await service?.applyAccounts(this.serviceAccountsState())
    if (result === null || typeof result === 'string') this.activeAccountId = result
    service?.noteActiveAccount(this.activeAccountId)
    this.options.onAdopted(this.authStatus())
  }

  /**
   * Remove one account (F18, D3): tokens go and its session stops; the caller
   * chooses whether the local rows go too (Delete) or stay dormant for a future
   * re-add to resume from stored cursors (Keep).
   *
   * The purge cannot run first — the utility refuses to delete rows while a
   * session still holds them, so the roster push that stops it has to precede
   * it. Instead the roster leaves memory before the purge and the tokens leave
   * disk only after it succeeded: a failed Delete therefore restores the
   * account (session included) and rejects, leaving a signed-in account whose
   * data is intact and whose Delete can be retried, rather than a retired
   * account with orphaned rows and no way back (B23).
   */
  async removeAccount(accountId: string, deleteData: boolean): Promise<AuthStatus> {
    const removedIndex = this.accountIds().indexOf(accountId)
    if (removedIndex < 0) throw new Error('unknown account')
    this.options.cancelSignIn()
    const previousSeedIds = this.seedAccountIds
    const previousStoredAccounts = this.storedAccounts
    const previousActiveAccountId = this.activeAccountId
    if (previousSeedIds.length > 0) {
      this.seedAccountIds = this.seedAccountIds.filter((id) => id !== accountId)
    } else {
      this.storedAccounts = this.storedAccounts.filter((account) => account.id !== accountId)
    }
    // Removing the active account activates the next by position; removing a
    // background account leaves the surface alone.
    if (this.activeAccountId === accountId) {
      const remaining = this.accountIds()
      this.activeAccountId = remaining[removedIndex] ?? remaining[0] ?? null
    }
    await this.adoptServiceAccounts()
    if (deleteData) {
      try {
        await this.options.service()?.internal('remove-account-data', accountId)
      } catch (error) {
        console.error(`[auth] could not delete local data for ${accountId}: ${errorMessage(error)}`)
        this.seedAccountIds = previousSeedIds
        this.storedAccounts = previousStoredAccounts
        this.activeAccountId = previousActiveAccountId
        await this.adoptServiceAccounts()
        throw error
      }
    }
    if (previousSeedIds.length === 0) {
      this.storedAccounts = this.tokens.remove(this.options.userDataPath(), accountId)
    }
    this.authGenerations.delete(accountId)
    console.log(`[auth] removed account ${accountId} (${deleteData ? 'deleted' : 'kept'} local data)`)
    return this.authStatus()
  }

  /**
   * Persist a new switcher order (F15). The permutation is validated against
   * the roster as it exists *now* — a stale request from before an add/remove
   * rejects, and the stored path re-reads the token file so a token refresh
   * that raced the reorder keeps its newest tokens. A failed persist throws
   * before the in-memory roster moves, leaving the old order intact. Sessions
   * are never restarted and the active account never changes: the utility
   * receives the same account set in its new order.
   */
  async reorderAccounts(accountIds: string[]): Promise<AuthStatus> {
    if (this.seedAccountIds.length > 0) {
      this.seedAccountIds = reorderIds(this.seedAccountIds, accountIds)
    } else {
      this.storedAccounts = this.tokens.reorder(this.options.userDataPath(), accountIds)
    }
    await this.adoptServiceAccounts()
    console.log(`[auth] reordered accounts: ${this.accountIds().join(', ')}`)
    return this.authStatus()
  }

  async setActiveAccount(accountId: string): Promise<AuthStatus> {
    if (!this.accountIds().includes(accountId)) throw new Error('unknown account')
    // The utility owns the flip: the response guarantees every later read the
    // renderer issues is answered for the new account.
    const service = this.options.service()
    const result = await service?.internal('set-active-account', accountId)
    this.activeAccountId = typeof result === 'string' ? result : accountId
    service?.noteActiveAccount(this.activeAccountId)
    this.options.onAdopted(this.authStatus())
    return this.authStatus()
  }

  /**
   * A refreshed token set from the utility. Returns false for a stale update —
   * a removed or re-authenticated account's client — which must never
   * overwrite newer tokens on disk.
   */
  applyTokenUpdate(event: TokenUpdateEvent): boolean {
    const userDataPath = this.options.userDataPath()
    // One decrypt per refresh: the roster read for the staleness check is the
    // same one the write starts from.
    const roster = this.tokens.load(userDataPath)
    const stored = roster.find((account) => account.id === event.accountId)
    if (!isCurrentTokenUpdate(this.authGenerations.get(event.accountId), stored, event)) {
      console.warn(
        `[auth] ignored stale token update for ${event.accountId} (generation ${event.generation})`
      )
      return false
    }
    this.storedAccounts = this.tokens.save(userDataPath, event.tokens, roster)
    return true
  }
}
