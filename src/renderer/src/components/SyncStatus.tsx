import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncStage, SyncState } from '../../../shared/mail'
import { blurActive } from './blurActive'

function syncStageLabel(stage: SyncStage): string {
  if (stage === 'metadata') return 'Message list'
  if (stage === 'bodies') return 'Recent mail'
  if (stage === 'drafts') return 'Drafts'
  if (stage === 'all-mail') return 'All mail'
  if (stage === 'spam') return 'Spam'
  if (stage === 'trash') return 'Trash'
  return 'Finishing up'
}

function lifetimeEta(etaMs: number | undefined): string {
  if (etaMs === undefined) return ''
  const minutes = Math.max(1, Math.ceil(etaMs / 60_000))
  if (minutes < 60) return ` · ${minutes} min remaining`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return ` · ${hours} hr remaining`
  const days = Math.ceil(hours / 24)
  return ` · ${days} day${days === 1 ? '' : 's'} remaining`
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
            : sync.phase === 'indexing'
              ? 'indexing'
              : 'syncing'
  const syncingStage = sync.phase === 'syncing' ? sync.stage : 'metadata'
  const lifetimeTotal =
    sync.phase === 'indexing' &&
    sync.stage === 'lifetime' &&
    sync.threadsTotal !== undefined &&
    sync.threadsTotal >= sync.threadsDone
      ? sync.threadsTotal
      : undefined
  const lifetimeCount =
    sync.phase === 'indexing'
      ? `${sync.threadsDone.toLocaleString()}${
          lifetimeTotal === undefined ? '' : ` of ${lifetimeTotal.toLocaleString()}`
        } threads`
      : ''
  const indexedLifetimeCount = `${lifetimeCount} indexed`
  const lifetimeDetail =
    sync.phase !== 'indexing'
      ? ''
      : sync.reason === 'quota-wait'
        ? `Quota pacing · ${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
        : sync.reason === 'foreground-yield'
          ? `Foreground work first · ${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
          : sync.reason === 'retry-wait'
            ? `Indexing paused · retrying soon · ${indexedLifetimeCount}`
            : sync.reason === 'paused'
              ? `Indexing paused · ${indexedLifetimeCount}`
              : sync.stage === 'attachments'
                ? `Attachment index · ${lifetimeCount} flagged`
                : sync.stage === 'split-metadata'
                  ? `Split inbox metadata · ${lifetimeCount} refreshed`
                  : `${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
  const quotaEvidence =
    sync.phase === 'indexing' && sync.quotaWaitMs !== undefined && sync.quotaWaitMs >= 1_000
      ? ` · ${Math.round(sync.quotaWaitMs / 1000).toLocaleString()}s quota wait`
      : ''

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
      : displayState === 'indexing'
        ? 'Indexing'
        : displayState === 'offline'
          ? 'Offline'
          : displayState === 'error'
            ? 'Error'
            : displayState === 'checking'
              ? 'Checking'
              : 'Syncing'
  const detail =
    displayState === 'live'
      ? 'Up to date'
      : displayState === 'indexing'
        ? lifetimeDetail
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
          ? `${syncStageLabel(syncingStage)}: ${sync.threadsDone} processed`
          : displayState === 'indexing' && sync.phase === 'indexing'
            ? `${label} — ${lifetimeDetail}${quotaEvidence}${
                sync.messagesTotal === undefined
                  ? ''
                  : ` · ${sync.messagesTotal.toLocaleString()} messages in account`
              }`
            : `${label} — ${detail}`
  const liveAnnouncement =
    displayState === 'indexing' && sync.phase === 'indexing'
      ? sync.reason === 'retry-wait'
        ? 'Older mail indexing paused; retrying soon'
        : sync.reason === 'paused'
          ? 'Older mail indexing paused'
          : 'Older mail indexing in progress'
      : `${label}${detail ? `: ${detail}` : ''}`

  const body = (
    <>
      <span className="app-status-dot size-[5px] rounded-full" aria-hidden />
      <span
        className={`whitespace-nowrap text-[11px] font-normal ${
          displayState === 'error' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        {label}
      </span>
    </>
  )

  return (
    <div
      ref={wrapRef}
      data-testid="status-note"
      data-status={displayState}
      className="relative flex min-w-0 flex-none justify-end"
    >
      <span className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </span>
      {displayState === 'error' && sync.phase === 'error' ? (
        <button
          type="button"
          data-testid="status-error-button"
          className="flex h-7 cursor-pointer items-center gap-2 text-left"
          aria-expanded={detailsOpen}
          aria-controls="sync-error-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {body}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-label={`${label}: show sync details`}
          onClick={() => setDetailsOpen((open) => !open)}
          data-testid="status-content"
          className="flex h-7 cursor-pointer items-center gap-2"
        >
          {body}
        </button>
      )}

      {detailsOpen && sync.phase !== 'error' && (
        <div
          role="dialog"
          aria-label="Sync details"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-[10px] border border-edge bg-raised p-3.5 text-xs text-ink-dim shadow-menu"
        >
          {title}
        </div>
      )}
      {detailsOpen && sync.phase === 'error' && (
        <div
          id="sync-error-details"
          data-testid="status-error-details"
          role="dialog"
          aria-label="Sync error details"
          className="absolute right-0 top-full z-50 mt-2 w-[330px] rounded-[10px] border border-edge bg-raised p-3.5 text-left shadow-menu"
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
