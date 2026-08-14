import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus } from '../../shared/auth'
import { Inbox } from './components/Inbox'
import { LoginScreen } from './components/LoginScreen'

const attn = window.attn

// Auth is the only state above the inbox: `Inbox` mounts once a signed-in status
// exists and unmounts on sign-out, so mail subscriptions and key handlers are
// inert while the login screen is up.
export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

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

  if (!attn || !status?.signedIn) {
    return (
      <LoginScreen
        status={status}
        statusError={statusError}
        onRetryStatus={loadStatus}
        onStatus={setStatus}
      />
    )
  }
  return <Inbox status={status} onStatus={setStatus} />
}
