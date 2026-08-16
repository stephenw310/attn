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
  const visibleProgress = toast ? null : progress
  const ratio = visibleProgress
    ? visibleProgress.totalBytes > 0
      ? visibleProgress.completedBytes / visibleProgress.totalBytes
      : visibleProgress.completedAttachments / Math.max(1, visibleProgress.totalAttachments)
    : 0
  return (
    <div
      key={toast?.id ?? `progress-${visibleProgress?.id}`}
      data-testid="toast"
      data-toast-id={toast?.id}
      className="pointer-events-none fixed bottom-14 left-1/2 z-50 -translate-x-1/2"
    >
      <div
        className={`${visibleProgress ? '' : 'app-confirmation-toast'} min-w-64 overflow-hidden rounded-xl border border-white/70 bg-ink text-ground shadow-[0_12px_40px_rgba(0,0,0,0.65)]`}
      >
        <div className="px-5 py-3 text-sm font-semibold">
          {visibleProgress
            ? `Sending attachments… ${visibleProgress.completedAttachments} of ${visibleProgress.totalAttachments}`
            : toast?.message}
        </div>
        {visibleProgress && (
          <div
            className="h-1 bg-ground/20"
            data-testid="outbox-progress"
            data-completed-attachments={visibleProgress.completedAttachments}
            data-total-attachments={visibleProgress.totalAttachments}
            role="progressbar"
            aria-label="Attachment upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.max(0, Math.min(1, ratio)) * 100)}
          >
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
