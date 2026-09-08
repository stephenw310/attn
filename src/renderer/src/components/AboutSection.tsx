import { useEffect, useState } from 'react'
import { describeUpdateStatus } from '../../../shared/distribution'
import { useAppUpdate } from '../hooks/useAppUpdate'
import { useShowToast } from '../toastContext'
import { ACTION_BUTTON, NOTE, ROW } from './settingsStyles'

// The About pane (F15): which build this is and what its updater is doing.
// Everything shown comes from main — the renderer never reads package.json or
// guesses at a feed — and the two buttons are the same commands the palette
// offers (`Check for updates`, `Restart to update`).

/** The status line re-reads its relative time once a minute. */
const STATUS_TICK_MS = 60_000

const BUILD_LABELS = {
  development: 'Development build',
  personal: 'Personal build',
  release: 'Release build'
} as const

export function AboutSection(): React.JSX.Element {
  const onToast = useShowToast()
  const { info, state, check, restart } = useAppUpdate()
  const [now, setNow] = useState(() => Date.now())
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), STATUS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await check()
      setNow(Date.now())
    } catch {
      onToast('Could not check for updates')
    } finally {
      setChecking(false)
    }
  }

  const runRestart = async (): Promise<void> => {
    const applying = await restart().catch(() => false)
    if (!applying) onToast('No update is ready yet')
  }

  const buildLine = info
    ? `${BUILD_LABELS[info.distribution]}${info.feed ? `. Updates from ${info.feed}` : ''}`
    : 'Loading…'

  return (
    <>
      <div className={`mt-2 ${ROW}`}>
        <span className="flex min-w-0 flex-col">
          <span data-testid="settings-app-version" className="text-sm text-ink">
            Attn {info ? `v${info.version}` : ''}
          </span>
          <span data-testid="settings-app-build" className={NOTE}>
            {buildLine}
          </span>
        </span>
      </div>
      <div className={ROW}>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-ink">Updates</span>
          <span data-testid="settings-update-status" className={NOTE}>
            {describeUpdateStatus(info, state, now)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {info?.updaterActive && (
            <button
              type="button"
              data-testid="settings-update-check"
              disabled={checking || state.phase !== 'idle'}
              onClick={() => void runCheck()}
              className={ACTION_BUTTON}
            >
              Check for updates
            </button>
          )}
          {state.phase === 'ready' && (
            <button
              type="button"
              data-testid="settings-update-restart"
              onClick={() => void runRestart()}
              className={ACTION_BUTTON}
            >
              Restart to update
            </button>
          )}
        </span>
      </div>
    </>
  )
}
