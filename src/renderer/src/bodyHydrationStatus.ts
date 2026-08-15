import type { MessageBodyState } from '../../shared/mail'

interface HydrationAttemptInput {
  account: string | null
  threadId: string
  readerOpen: boolean
  online: boolean
}

export interface HydrationAttemptDecision {
  allowHydration: boolean
  nextTarget: string | null
}

/** Allow one network attempt per selected-thread visit, reconnect, or reader reopen. */
export function hydrationAttemptDecision(
  previousTarget: string | null,
  input: HydrationAttemptInput
): HydrationAttemptDecision {
  if (!input.account || !input.readerOpen || !input.online) {
    return { allowHydration: false, nextTarget: null }
  }
  const nextTarget = `${input.account}\0${input.threadId}`
  return { allowHydration: previousTarget !== nextTarget, nextTarget }
}

export function bodyHydrationStatusMessage(
  bodyState: MessageBodyState,
  online: boolean,
  failed: boolean
): string | undefined {
  if (bodyState === 'complete' || bodyState === 'unavailable') return undefined
  if (!online) return "Full message loads when you're back online"
  if (bodyState === 'signed-out') return 'Full message loads when signed in'
  if (failed) return undefined
  return 'Loading full message…'
}
