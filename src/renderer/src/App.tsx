import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus } from '../../shared/auth'
import { Inbox } from './components/Inbox'
import { LoginScreen } from './components/LoginScreen'

const attn = window.attn

// Account-removal errors live above the keyed inbox so sign-out cannot hide them.
// Mail subscriptions and key handlers remain inert while the login screen is up.
export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [removalError, setRemovalError] = useState<string | null>(null)

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
          onRemovalError={setRemovalError}
        />
      )}
      {removalError && (
        <div
          role="alert"
          data-testid="account-removal-error"
          className="fixed bottom-14 left-1/2 z-50 flex w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-4 rounded-lg border border-edge bg-raised p-4 text-sm text-ink shadow-menu"
        >
          <p className="min-w-0 flex-1 break-words">{removalError}</p>
          <button
            type="button"
            data-testid="account-removal-error-dismiss"
            className="cursor-pointer rounded px-2 py-1 text-accent hover:bg-active"
            onClick={() => setRemovalError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
