import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncStage, SyncState } from '../../../shared/mail'
import { blurActive } from './blurActive'

const SYNC_STAGES: SyncStage[] = ['metadata', 'bodies', 'sent', 'reconcile']

function syncStageLabel(stage: SyncStage): string {
  if (stage === 'metadata') return 'Message list'
  if (stage === 'bodies') return 'Recent mail'
  if (stage === 'sent') return 'Sent mail'
  return 'Finishing up'
}

function SyncProgress({ stage }: { stage: SyncStage }): React.JSX.Element {
  const activeIndex = SYNC_STAGES.indexOf(stage)
  return (
    <span
      data-testid="sync-progress"
      role="progressbar"
      aria-label={`Sync phase ${activeIndex + 1} of ${SYNC_STAGES.length}: ${syncStageLabel(stage)}`}
      aria-valuemin={1}
      aria-valuemax={SYNC_STAGES.length}
      aria-valuenow={activeIndex + 1}
      className="col-start-2 grid h-[3px] w-44 grid-cols-4 gap-[3px] overflow-hidden"
    >
      {SYNC_STAGES.map((item, index) => (
        <i
          key={item}
          data-phase-state={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending'}
          className="app-sync-phase-segment overflow-hidden rounded-full bg-edge"
        />
      ))}
    </span>
  )
}

interface SyncStatusProps {
  sync: SyncState
  networkOnline: boolean
  onRetry: () => void
  onCopyError: (message: string) => void
}

export function SyncStatus(props: SyncStatusProps): React.JSX.Element {
  const { sync, networkOnline, onRetry, onCopyError } = props
  const [detailsOpen, setDetailsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const displayState =
    sync.phase === 'error'
      ? 'error'
      : sync.phase === 'offline' || !networkOnline
        ? 'offline'
        : sync.phase === 'idle'
          ? 'live'
          : sync.phase === 'checking'
            ? 'checking'
            : 'syncing'
  const syncingStage = sync.phase === 'syncing' ? sync.stage : 'metadata'

  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
    blurActive()
  }, [])

  useEffect(() => {
    if (sync.phase !== 'error') setDetailsOpen(false)
  }, [sync.phase])

  useEffect(() => {
    if (!detailsOpen) return
    const onDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closeDetails()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeDetails()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeDetails, detailsOpen])

  const label =
    displayState === 'live'
      ? 'Live'
      : displayState === 'offline'
        ? 'Offline'
        : displayState === 'error'
          ? 'Error'
          : displayState === 'checking'
            ? 'Checking mail'
            : `Syncing · ${syncStageLabel(syncingStage)}`
  const detail =
    displayState === 'live'
      ? 'Up to date'
      : displayState === 'offline'
        ? 'Local mail available'
        : displayState === 'error'
          ? 'Click for details'
          : displayState === 'checking'
            ? 'Looking for new mail'
            : null
  const title =
    displayState === 'error' && sync.phase === 'error'
      ? sync.message
      : displayState === 'offline' && sync.phase === 'offline'
        ? sync.message
        : displayState === 'syncing' && sync.phase === 'syncing'
          ? `${label} — ${sync.threadsDone} processed`
          : `${label} — ${detail}`

  const body = (
    <>
      <span className="app-status-dot row-start-1 size-[7px] rounded-full" aria-hidden />
      <span
        className={`row-start-1 whitespace-nowrap text-[11.5px] font-semibold ${
          displayState === 'error' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        {label}
      </span>
      {displayState === 'syncing' && sync.phase === 'syncing' ? (
        <SyncProgress stage={sync.stage} />
      ) : (
        <span className="col-start-2 row-start-2 text-[9.5px] leading-[10px] text-ink-faint">{detail}</span>
      )}
    </>
  )

  return (
    <div
      ref={wrapRef}
      data-testid="status-note"
      data-status={displayState}
      className="relative ml-auto flex w-[196px] flex-none justify-end"
      title={title}
      aria-live="polite"
    >
      {displayState === 'error' && sync.phase === 'error' ? (
        <button
          type="button"
          data-testid="status-error-button"
          className="grid w-fit cursor-pointer grid-cols-[7px_auto] grid-rows-[17px_10px] items-center gap-x-2 text-left"
          aria-expanded={detailsOpen}
          aria-controls="sync-error-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {body}
        </button>
      ) : (
        <div
          data-testid="status-content"
          className="grid w-fit grid-cols-[7px_auto] grid-rows-[17px_10px] items-center gap-x-2"
        >
          {body}
        </div>
      )}

      {detailsOpen && sync.phase === 'error' && (
        <div
          id="sync-error-details"
          data-testid="status-error-details"
          role="dialog"
          aria-label="Sync error details"
          className="absolute right-0 bottom-full z-50 mb-2 w-[330px] rounded-[10px] border border-edge bg-raised p-3.5 text-left shadow-[0_15px_42px_rgba(0,0,0,0.58)]"
        >
          <div className="flex items-center gap-2 text-xs font-bold text-ink">
            <span className="text-danger" aria-hidden>
              ●
            </span>
            Gmail sync error
          </div>
          <p
            data-testid="status-error-message"
            className="my-2 max-h-48 overflow-y-auto break-words text-[11px] leading-[1.45] text-ink-dim"
          >
            {sync.message}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="status-retry"
              className="cursor-pointer rounded-md border border-edge bg-active px-2.5 py-1.5 text-[10.5px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
              onClick={() => {
                setDetailsOpen(false)
                onRetry()
              }}
            >
              Retry now
            </button>
            <button
              type="button"
              data-testid="status-copy-error"
              className="cursor-pointer rounded-md border border-edge bg-active px-2.5 py-1.5 text-[10.5px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
              onClick={() => onCopyError(sync.message)}
            >
              Copy details
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
