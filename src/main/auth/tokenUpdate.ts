import type { TokenSet } from './googleAuth'
import { accountIdForTokens, type StoredAccount } from './tokenFile'

export interface TokenUpdate {
  accountId: string
  tokens: TokenSet
  generation: number
}

/**
 * A refresh from the utility applies only while its account is still in the
 * roster, the update carries that account's current auth generation, and the
 * refreshed tokens still identify the same address — a stale client from a
 * removed or re-authenticated session must never overwrite newer tokens.
 */
export function isCurrentTokenUpdate(
  currentGeneration: number | undefined,
  storedAccount: StoredAccount | undefined,
  update: TokenUpdate
): boolean {
  return (
    storedAccount !== undefined &&
    update.generation === currentGeneration &&
    accountIdForTokens(update.tokens) === storedAccount.id
  )
}
