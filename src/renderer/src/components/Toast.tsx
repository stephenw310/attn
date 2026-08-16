import type { CSSProperties } from 'react'
import type { ToastState } from '../hooks/useToast'

export function Toast({ toast }: { toast: ToastState | null }): React.JSX.Element | null {
  if (!toast) return null
  const timingStyle = { '--toast-duration': `${toast.durationMs}ms` } as CSSProperties
  return (
    <div
      key={toast.id}
      data-testid="toast"
      data-toast-id={toast.id}
      data-toast-duration-ms={toast.durationMs}
      data-toast-expires-at={toast.expiresAt}
      className="pointer-events-none fixed bottom-14 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2"
    >
      <div
        className="app-confirmation-toast min-w-56 max-w-full overflow-hidden rounded-xl border border-white/70 bg-ink text-base font-semibold text-ground shadow-[0_12px_40px_rgba(0,0,0,0.65)]"
        style={timingStyle}
      >
        <div className="break-words px-5 py-3 text-center">{toast.message}</div>
        {toast.countdown ? (
          <div data-testid="toast-countdown" className="h-1 bg-ground/25" aria-hidden="true">
            <div className="app-toast-countdown h-full bg-ground" style={timingStyle} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
