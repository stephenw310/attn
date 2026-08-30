import type { AuthSignInResult } from '../../shared/auth'

export function actionReconnectMessage(activeAccount: string, result: AuthSignInResult): string {
  const { status, resumedActions } = result
  if (!status.configured && resumedActions === 0) {
    return 'Google OAuth is not configured — pending changes remain paused.'
  }
  if (!status.signedIn) return 'Google was not reconnected — pending changes remain paused.'
  // Sign-in no longer activates a different account, so the flow's own
  // accountId — not the (unchanged) active email — says who reconnected.
  const connected = result.accountId ?? status.email
  if (connected !== activeAccount) {
    return connected
      ? `Connected as ${connected} — pending changes for ${activeAccount} remain paused.`
      : `Pending changes for ${activeAccount} remain paused.`
  }
  if (resumedActions === 0) return 'Google reconnected, but no paused changes were resumed.'
  return `Google reconnected — ${resumedActions} pending ${resumedActions === 1 ? 'change is' : 'changes are'} retrying.`
}
