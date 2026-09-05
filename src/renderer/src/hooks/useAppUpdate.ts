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
 * never missed. Main broadcasts each completed check after the checking phase;
 * applying a check's response here could overwrite a newer pushed state.
 */
export function useAppUpdate(): AppUpdateApi {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [state, setState] = useState<UpdateState>(UPDATE_STATE_IDLE)

  useEffect(() => {
    const attn = window.attn
    if (!attn) return
    let stale = false
    // A push that lands while the snapshot request is in flight is newer than
    // the snapshot; the snapshot then only fills in when nothing was pushed.
    let pushed = false
    const unsubscribe = attn.update.onState((next) => {
      if (stale) return
      pushed = true
      setState(next)
    })
    void attn.update
      .getState()
      .then((next) => {
        if (!stale && !pushed) setState(next)
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

  const check = useCallback((): Promise<UpdateState> => {
    return window.attn?.update.check() ?? Promise.resolve(UPDATE_STATE_IDLE)
  }, [])

  const restart = useCallback((): Promise<boolean> => {
    return window.attn?.update.restart() ?? Promise.resolve(false)
  }, [])

  return { info, state, check, restart }
}
