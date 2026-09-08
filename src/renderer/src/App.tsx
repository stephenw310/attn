import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../shared/auth'
import { Inbox } from './components/Inbox'
import { LoginScreen } from './components/LoginScreen'
import { orderRoster } from './roster'

const attn = window.attn

// Account-removal errors live above the keyed inbox so sign-out cannot hide them.
// Mail subscriptions and key handlers remain inert while the login screen is up.
export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [removalError, setRemovalError] = useState<string | null>(null)

  // A reorder response carries a status snapshot computed when the reorder
  // committed, which can predate an account switch — or a removal, or a
  // LATER reorder — made while it was in flight, and a switch remounts the
  // keyed Inbox, so no Inbox-held state survives to judge it. The request
  // therefore starts here, above the remount: the ticket rejects a response
  // that a newer reorder has superseded, and what does land adopts only the
  // ordering, restricted to whatever roster is live at that point
  // (PR #101 review, twice).
  const reorderTicketRef = useRef(0)
  const reorderRoster = useCallback(async (ids: string[]) => {
    if (!attn) return
    const ticket = ++reorderTicketRef.current
    const next = await attn.auth.reorderAccounts(ids)
    if (ticket !== reorderTicketRef.current) return
    setStatus((current) =>
      current ? { ...current, accounts: orderRoster(current.accounts, next.accounts) } : next
    )
  }, [])

  // A ready update announces itself once per run. The dedupe sits here, above
  // the account-keyed Inbox, so switching accounts does not re-announce an
  // update the user has already seen (B24).
  const announcedUpdateRef = useRef<string | null>(null)
  const claimUpdateAnnouncement = useCallback((version: string): boolean => {
    if (announcedUpdateRef.current === version) return false
    announcedUpdateRef.current = version
    return true
  }, [])

  const loadStatus = useCallback(() => {
    if (!attn) return
    setStatusError(null)
    attn.auth
      .getStatus()
      .then(setStatus)
      .catch((reason: unknown) =>
        setStatusError(reason instanceof Error ? reason.message : 'Could not read sign-in status')
      )
  }, [])

  useEffect(loadStatus, [loadStatus])

  return (
    <>
      {!attn || !status?.signedIn ? (
        <LoginScreen
          status={status}
          statusError={statusError}
          onRetryStatus={loadStatus}
          onStatus={setStatus}
        />
      ) : (
        // A switch remounts all mail state, so the new account never renders old rows.
        <Inbox
          key={status.activeAccountId ?? 'account'}
          status={status}
          onStatus={setStatus}
          onReorderAccounts={reorderRoster}
          onRemovalError={setRemovalError}
          onClaimUpdateAnnouncement={claimUpdateAnnouncement}
        />
      )}
      {removalError && (
        <div
          role="alert"
          data-testid="account-removal-error"
          className="fixed bottom-14 left-1/2 z-50 flex w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-4 border border-edge bg-raised p-4 text-sm text-ink shadow-menu"
        >
          <p className="min-w-0 flex-1 break-words">{removalError}</p>
          <button
            type="button"
            data-testid="account-removal-error-dismiss"
            className="cursor-pointer px-2 py-1 text-accent hover:bg-active"
            onClick={() => setRemovalError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
