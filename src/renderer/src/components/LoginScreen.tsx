import { useCallback, useState } from 'react'
import { type AuthStatus, isSignInCanceled } from '../../../shared/auth'
import { PaperSheet, Seal } from './Hand'

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
        setError(reason instanceof Error ? reason.message : 'Could not sign in')
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
      // No background here: the sheet is painted behind the window at a negative
      // z-index, and a positioned wrapper with its own ground would cover it.
      className="app-drag relative flex h-full flex-col overflow-hidden"
    >
      <PaperSheet bandWidth={0} />
      <div className="app-login-backdrop pointer-events-none absolute inset-0 opacity-80" />
      <header className="relative flex items-center px-7 py-5">
        <div className="font-gotisch flex items-center gap-2 text-[26px] leading-none text-ink">
          attn
          <Seal letter="a" />
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 items-center justify-center px-6 pb-14">
        <section className="app-no-drag w-full max-w-[430px] text-center">
          <div className="mx-auto mb-7 flex size-14 items-center justify-center border border-accent/25 bg-accent/[0.08] text-accent shadow-dialog">
            <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none">
              <title>Mail</title>
              <path
                d="M4 7.5 12 13l8-5.5M5.5 18h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18.5 6h-13A1.5 1.5 0 0 0 4 7.5v9A1.5 1.5 0 0 0 5.5 18Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="app-small-caps mb-3 text-[14px] text-accent">Your inbox, in focus</p>
          <h1 className="font-serif text-[38px] leading-[46px] text-ink">Make space for what matters.</h1>
          <p className="font-letter mx-auto mt-3 max-w-[44ch] text-[17.5px] leading-[28px] text-ink-dim">
            Sign in with Google to bring your Gmail into a fast, keyboard-first inbox that keeps its local
            copy on this device.
          </p>

          {/* Keyboard-first: the screen's only action answers Enter on arrival. */}
          <button
            type="button"
            data-testid="login-google"
            // biome-ignore lint/a11y/noAutofocus: sole action on a dedicated screen
            autoFocus
            disabled={!configured || busy || !bridgeAvailable}
            onClick={signIn}
            className="mt-8 flex h-12 w-full cursor-pointer items-center justify-center gap-3 border border-white/15 bg-[#f3f4f7] px-5 text-sm font-semibold text-[#202124] shadow-[0_10px_30px_rgba(0,0,0,0.28)] transition hover:bg-white disabled:cursor-default disabled:opacity-45"
          >
            <span className="flex size-5 items-center justify-center rounded-full border border-[#dadce0] bg-white text-[12px] font-bold text-[#4285f4]">
              G
            </span>
            {busy ? 'Waiting for Google…' : 'Continue with Google'}
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

          <div className="app-small-caps mt-7 flex items-center justify-center gap-6 text-[12px] text-ink-faint">
            <span>Local-first</span>
            <span>Keyboard-first</span>
            <span>Private by design</span>
          </div>
        </section>
      </main>
    </div>
  )
}
