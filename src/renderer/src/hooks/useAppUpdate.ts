import { useCallback, useEffect, useState } from 'react'
import { type AppInfo, UPDATE_STATE_IDLE, type UpdateState } from '../../../shared/distribution'

export interface AppUpdateApi {
  /** Null until the first read lands. */
  info: AppInfo | null
  state: UpdateState
  /** Run one check now and resolve with the state it left (T39 `checkNow`). */
  check: () => Promise<UpdateState>
  /** The palette's `Restart to update`; false when nothing installable is ready. */
  restart: () => Promise<boolean>
}

/**
 * The About surface's view of this build and its updater (F15, T39). Subscribes
 * before reading so a state change that lands between mount and the read is
 * never missed; a manual check applies its own answer, since main only
 * broadcasts phase changes and an up-to-date check ends where it began.
 */
export function useAppUpdate(): AppUpdateApi {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [state, setState] = useState<UpdateState>(UPDATE_STATE_IDLE)

  useEffect(() => {
    const attn = window.attn
    if (!attn) return
    let stale = false
    const unsubscribe = attn.update.onState((next) => {
      if (!stale) setState(next)
    })
    void attn.update
      .getState()
      .then((next) => {
        if (!stale) setState(next)
      })
      .catch(() => {})
    void attn.app
      .getInfo()
      .then((next) => {
        if (!stale) setInfo(next)
      })
      .catch(() => {})
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])

  const check = useCallback(async (): Promise<UpdateState> => {
    const attn = window.attn
    if (!attn) return UPDATE_STATE_IDLE
    const next = await attn.update.check()
    setState(next)
    return next
  }, [])

  const restart = useCallback((): Promise<boolean> => {
    return window.attn?.update.restart() ?? Promise.resolve(false)
  }, [])

  return { info, state, check, restart }
}
