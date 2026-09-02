// Auto-update state shared across processes (T39). The renderer only ever
// sees this snapshot: a quiet toast when an update is ready and the
// `Restart to update` palette command; nothing here can force a restart.

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready'

export interface UpdateState {
  phase: UpdatePhase
  /** The downloaded-and-ready version, when phase is 'ready'. */
  readyVersion: string | null
}

export const UPDATE_STATE_IDLE: UpdateState = { phase: 'idle', readyVersion: null }
