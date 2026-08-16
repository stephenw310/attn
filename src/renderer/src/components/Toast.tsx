import type { CSSProperties } from 'react'
import type { OutboxProgress } from '../../../shared/outbox'
import type { ToastState } from '../hooks/useToast'

export function Toast({
  toast,
  progress
}: {
  toast: ToastState | null
  progress?: OutboxProgress | null
}): React.JSX.Element | null {
  if (!toast && !progress) return null
  // An actionable toast outranks upload progress: the bar comes back when the
  // toast clears, but a failure notice hidden behind it is gone for good.
  if (toast) {
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
  if (!progress) return null
  const ratio =
    progress.totalBytes > 0
      ? progress.completedBytes / progress.totalBytes
      : progress.completedAttachments / Math.max(1, progress.totalAttachments)
  const percent = Math.max(0, Math.min(1, ratio)) * 100
  return (
    <div
      key={`progress-${progress.id}`}
      data-testid="toast"
      className="pointer-events-none fixed bottom-14 left-1/2 z-50 -translate-x-1/2"
    >
      <div className="min-w-64 overflow-hidden rounded-xl border border-white/70 bg-ink text-ground shadow-[0_12px_40px_rgba(0,0,0,0.65)]">
        <div className="px-5 py-3 text-sm font-semibold">
          {`Sending attachments… ${progress.completedAttachments} of ${progress.totalAttachments}`}
        </div>
        <div
          className="h-1 bg-ground/20"
          data-testid="outbox-progress"
          data-completed-attachments={progress.completedAttachments}
          data-total-attachments={progress.totalAttachments}
          role="progressbar"
          aria-label="Attachment upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  )
}
