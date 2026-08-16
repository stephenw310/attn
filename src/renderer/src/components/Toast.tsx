import type { ToastState } from '../hooks/useToast'

export function Toast({ toast }: { toast: ToastState | null }): React.JSX.Element | null {
  if (!toast) return null
  return (
    <div
      key={toast.id}
      data-testid="toast"
      data-toast-id={toast.id}
      className="pointer-events-none fixed bottom-14 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2"
    >
      <div className="app-confirmation-toast break-words rounded-xl border border-white/70 bg-ink px-5 py-3 text-center text-base font-semibold text-ground shadow-[0_12px_40px_rgba(0,0,0,0.65)]">
        {toast.message}
      </div>
    </div>
  )
}
