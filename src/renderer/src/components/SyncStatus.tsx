import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncStage, SyncState } from '../../../shared/mail'
import { blurActive } from './blurActive'
import { ScrapEdge } from './Hand'

const SYNC_STAGES: SyncStage[] = ['metadata', 'bodies', 'drafts', 'all-mail', 'spam', 'trash', 'reconcile']

/**
 * The seven stages of a first sync, as the app tells them. Nothing here
 * renames a feature: the courier is what the app is doing, not a place the
 * user can go or a control they can press.
 */
function syncStageLabel(stage: SyncStage): string {
  if (stage === 'metadata') return 'Courier unpacking the ledger'
  if (stage === 'bodies') return 'Courier unpacking recent letters'
  if (stage === 'drafts') return 'Courier unpacking your drafts'
  if (stage === 'all-mail') return 'Courier unpacking the whole archive'
  if (stage === 'spam') return 'Courier unpacking the spam pile'
  if (stage === 'trash') return 'Courier unpacking the trash'
  return 'Courier sealing the ledger'
}

function lifetimeEta(etaMs: number | undefined): string {
  if (etaMs === undefined) return ''
  const minutes = Math.max(1, Math.ceil(etaMs / 60_000))
  if (minutes < 60) return `, ${minutes} min remaining`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `, ${hours} hr remaining`
  const days = Math.ceil(hours / 24)
  return `, ${days} day${days === 1 ? '' : 's'} remaining`
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
      className="col-start-2 grid h-[3px] w-44 gap-[3px] overflow-hidden"
      // One column per stage, derived from the list: a fixed `grid-cols-N` went
      // stale when the pipeline grew from five stages to seven and clipped the
      // last two segments into an invisible second row.
      style={{ gridTemplateColumns: `repeat(${SYNC_STAGES.length}, minmax(0, 1fr))` }}
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
  const indexedLifetimeCount = `${lifetimeCount} copied`
  const resting = sync.phase === 'indexing' && (sync.reason === 'retry-wait' || sync.reason === 'paused')
  const lifetimeDetail =
    sync.phase !== 'indexing'
      ? ''
      : sync.reason === 'quota-wait'
        ? `Gmail rations its pages. ${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
        : sync.reason === 'foreground-yield'
          ? `Your work first. ${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
          : sync.reason === 'retry-wait'
            ? `Back to the archive soon. ${indexedLifetimeCount}`
            : sync.reason === 'paused'
              ? indexedLifetimeCount
              : sync.stage === 'attachments'
                ? `Noting which letters carry enclosures, ${lifetimeCount} marked`
                : sync.stage === 'split-metadata'
                  ? `Sorting into inbox splits, ${lifetimeCount} refreshed`
                  : `${indexedLifetimeCount}${lifetimeEta(sync.etaMs)}`
  const quotaEvidence =
    sync.phase === 'indexing' && sync.quotaWaitMs !== undefined && sync.quotaWaitMs >= 1_000
      ? `, ${Math.round(sync.quotaWaitMs / 1000).toLocaleString()}s quota wait`
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
      ? 'All letters received'
      : displayState === 'indexing'
        ? resting
          ? 'Scribes resting'
          : 'Scribes copying the archive'
        : displayState === 'offline'
          ? 'No road out'
          : displayState === 'error'
            ? 'Courier turned back'
            : displayState === 'checking'
              ? 'Courier at the gate'
              : syncStageLabel(syncingStage)
  const detail =
    displayState === 'live'
      ? 'Nothing on the road'
      : displayState === 'indexing'
        ? lifetimeDetail
        : displayState === 'offline'
          ? 'Your letters are still here to read'
          : displayState === 'error'
            ? 'Click for what happened'
            : displayState === 'checking'
              ? 'Asking after new letters'
              : null
  const title =
    displayState === 'error' && sync.phase === 'error'
      ? sync.message
      : displayState === 'offline' && sync.phase === 'offline'
        ? sync.message
        : displayState === 'syncing' && sync.phase === 'syncing'
          ? `${label}, ${sync.threadsDone} unpacked`
          : displayState === 'indexing' && sync.phase === 'indexing'
            ? `${label}. ${lifetimeDetail}${quotaEvidence}${
                sync.messagesTotal === undefined
                  ? ''
                  : `, ${sync.messagesTotal.toLocaleString()} messages in account`
              }`
            : `${label}. ${detail}`
  const liveAnnouncement =
    displayState === 'indexing' && sync.phase === 'indexing'
      ? sync.reason === 'retry-wait'
        ? 'The scribes are resting and will return to the archive soon'
        : sync.reason === 'paused'
          ? 'The scribes are resting'
          : 'The scribes are copying the archive'
      : `${label}${detail ? `: ${detail}` : ''}`

  const body = (
    <>
      <span className="app-status-dot row-start-1 size-[7px] rounded-full" aria-hidden />
      <span
        className={`row-start-1 whitespace-nowrap text-[14px] font-semibold ${
          displayState === 'error' ? 'text-danger' : 'text-ink-dim'
        }`}
      >
        {label}
      </span>
      {displayState === 'syncing' && sync.phase === 'syncing' ? (
        <SyncProgress stage={sync.stage} />
      ) : displayState === 'indexing' && sync.phase === 'indexing' ? (
        <span
          data-testid="lifetime-progress"
          role="progressbar"
          aria-label={`Lifetime header index: ${lifetimeDetail}`}
          aria-valuetext={lifetimeDetail}
          {...(lifetimeTotal === undefined
            ? {}
            : {
                'aria-valuemin': 0,
                'aria-valuemax': lifetimeTotal,
                'aria-valuenow': sync.threadsDone
              })}
          className="col-start-2 row-start-2 whitespace-nowrap text-[11.5px] leading-[13px] text-ink-faint"
        >
          {detail}
        </span>
      ) : (
        <span className="col-start-2 row-start-2 text-[11.5px] leading-[13px] text-ink-faint">{detail}</span>
      )}
    </>
  )

  return (
    <div
      ref={wrapRef}
      data-testid="status-note"
      data-status={displayState}
      className="relative ml-auto flex min-w-[210px] flex-none justify-end"
      title={title}
    >
      <span className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </span>
      {displayState === 'error' && sync.phase === 'error' ? (
        <button
          type="button"
          data-testid="status-error-button"
          className="grid w-fit cursor-pointer grid-cols-[7px_auto] grid-rows-[20px_13px] items-center gap-x-2 text-left"
          aria-expanded={detailsOpen}
          aria-controls="sync-error-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {body}
        </button>
      ) : (
        <div
          data-testid="status-content"
          className="grid w-fit grid-cols-[7px_auto] grid-rows-[20px_13px] items-center gap-x-2"
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
          className="absolute right-0 bottom-full isolate z-50 mb-2 w-[330px] p-4 text-left"
        >
          <ScrapEdge />
          <div className="flex items-center gap-2 text-xs font-bold text-ink">
            <span className="text-danger" aria-hidden>
              ●
            </span>
            The courier could not reach Gmail
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
              className="cursor-pointer border border-edge bg-active px-2.5 py-1.5 text-[12px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
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
              className="cursor-pointer border border-edge bg-active px-2.5 py-1.5 text-[12px] font-semibold text-ink-dim hover:border-accent hover:text-ink"
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
