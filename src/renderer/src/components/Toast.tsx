import { type CSSProperties, useEffect, useState } from 'react'
import type { OutboxProgress } from '../../../shared/outbox'
import type { ToastState } from '../hooks/useToast'
import { TOAST_COUNTDOWN_TICK_MS } from '../tuning'
import { Kbd } from './Kbd'

export function Toast({
  toast,
  progress,
  onUndo
}: {
  toast: ToastState | null
  progress?: OutboxProgress | null
  onUndo?: () => void
}): React.JSX.Element | null {
  const [undoingId, setUndoingId] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!toast?.countdown) return
    const timer = window.setInterval(() => setNow(Date.now()), TOAST_COUNTDOWN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [toast?.countdown])
  if (!toast && !progress) return null
  // An actionable toast outranks upload progress: the bar comes back when the
  // toast clears, but a failure notice hidden behind it is gone for good.
  if (toast) {
    const remaining = Math.max(0, toast.expiresAt - now)
    const timingStyle = {
      '--toast-duration': `${toast.durationMs}ms`
    } as CSSProperties
    return (
      <div
        key={toast.id}
        data-testid="toast"
        data-toast-id={toast.id}
        data-toast-duration-ms={toast.durationMs}
        data-toast-expires-at={toast.expiresAt}
        role="status"
        className="pointer-events-none fixed bottom-14 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2"
      >
        <div
          className="app-confirmation-toast min-w-56 max-w-full overflow-hidden rounded-[9px] border border-edge bg-raised text-xs text-ink shadow-toast"
          style={timingStyle}
        >
          <div className="flex items-center justify-center gap-6 px-5 py-3">
            <span className="break-words">
              {toast.countdown ? `Sending in ${Math.ceil(remaining / 1000)} seconds` : toast.message}
            </span>
            {toast.countdown && onUndo && remaining > 0 && (
              <button
                type="button"
                data-testid="toast-undo"
                className="pointer-events-auto flex shrink-0 cursor-pointer items-center gap-2 rounded px-1 py-1 text-ink hover:bg-active"
                disabled={undoingId === toast.id}
                onClick={() => {
                  setUndoingId(toast.id)
                  onUndo()
                }}
              >
                Undo <Kbd>Z</Kbd>
              </button>
            )}
          </div>
          {toast.countdown ? (
            <div data-testid="toast-countdown" className="h-1 bg-ground/25" aria-hidden="true">
              <div className="app-toast-countdown h-full bg-accent" style={timingStyle} />
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
      className="pointer-events-none fixed bottom-14 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2"
    >
      <div className="min-w-56 max-w-full overflow-hidden rounded-[9px] border border-edge bg-raised text-ink shadow-toast">
        <div className="px-5 py-3 text-xs">
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
