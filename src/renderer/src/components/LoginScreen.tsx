import { useCallback, useState } from 'react'
import { type AuthStatus, isSignInCanceled, signInErrorMessage } from '../../../shared/auth'
import tidalInlet from '../assets/login-tidal-inlet.png'

interface LoginScreenProps {
  status: AuthStatus | null
  statusError: string | null
  onRetryStatus: () => void
  onStatus: (status: AuthStatus) => void
}

export function LoginScreen(props: LoginScreenProps): React.JSX.Element {
  const { status, statusError, onRetryStatus, onStatus } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const configured = status?.configured === true
  const bridgeAvailable = Boolean(window.attn)

  const signIn = useCallback(() => {
    if (!window.attn || !configured) return
    setBusy(true)
    setError(null)
    window.attn.auth
      .signIn()
      .then(({ status: nextStatus }) => onStatus(nextStatus))
      .catch((reason: unknown) => {
        if (isSignInCanceled(reason)) return
        setError(signInErrorMessage(reason, 'Could not sign in.'))
      })
      .finally(() => setBusy(false))
  }, [configured, onStatus])

  const setupMessage = !bridgeAvailable
    ? 'Open Attn as a desktop app to continue.'
    : statusError !== null
      ? `Could not check sign-in status. ${statusError}`
      : status === null
        ? 'Checking sign-in availability…'
        : !configured
          ? 'This development build needs a Google OAuth client. Follow the setup steps in README.md, then restart Attn.'
          : null

  return (
    <div
      data-testid="login-screen"
      className="app-drag relative flex h-full flex-col overflow-hidden bg-ground"
    >
      <div
        className="app-login-tide pointer-events-none absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${tidalInlet})` }}
      />
      <main className="relative flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pt-[22vh] pb-10">
        <section className="app-no-drag w-full max-w-[480px] text-center">
          <div className="mb-16 text-[32px] font-semibold tracking-tight text-ink">Attn</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your mail, at your pace.</h1>
          <p className="mt-5 text-sm text-ink">Sign in with Google to bring your Gmail into Attn.</p>

          {/* Keyboard-first: the screen's only action answers Enter on arrival. */}
          <button
            type="button"
            data-testid="login-google"
            // biome-ignore lint/a11y/noAutofocus: sole action on a dedicated screen
            autoFocus
            disabled={!configured || busy || !bridgeAvailable}
            onClick={signIn}
            className="mx-auto mt-10 flex cursor-pointer items-center justify-center rounded-md bg-accent px-5 py-2.5 text-xs font-medium text-on-accent disabled:cursor-default disabled:opacity-45"
          >
            {busy ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>

          <div className="mt-4 min-h-10 text-xs leading-5 text-ink-faint" aria-live="polite">
            {error ? (
              <span data-testid="login-error" className="text-danger">
                Sign-in failed. {error}
              </span>
            ) : (
              setupMessage && <span data-testid="login-setup-message">{setupMessage}</span>
            )}
            {statusError !== null && (
              <button
                type="button"
                data-testid="login-status-retry"
                onClick={onRetryStatus}
                className="ml-1.5 cursor-pointer underline underline-offset-2 hover:text-ink-dim"
              >
                Try again
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
