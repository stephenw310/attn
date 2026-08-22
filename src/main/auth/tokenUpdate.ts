import type { TokenSet } from './googleAuth'

export interface TokenUpdate {
  tokens: TokenSet
  generation: number
}

export function isCurrentTokenUpdate(
  currentGeneration: number,
  currentTokens: TokenSet | null,
  update: TokenUpdate
): boolean {
  return (
    currentTokens !== null &&
    update.generation === currentGeneration &&
    update.tokens.email === currentTokens.email
  )
}
