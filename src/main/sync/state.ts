import type { SyncState } from '../../shared/mail'

/** Avoid renderer churn when a poll reports the state it already published. */
export function sameSyncState(left: SyncState, right: SyncState): boolean {
  if (left.phase !== right.phase) return false
  if (left.phase === 'syncing' && right.phase === 'syncing') {
    return left.stage === right.stage && left.threadsDone === right.threadsDone
  }
  if (left.phase === 'offline' && right.phase === 'offline') {
    return left.message === right.message
  }
  if (left.phase === 'error' && right.phase === 'error') {
    return left.message === right.message
  }
  return left.phase === 'idle' && right.phase === 'idle'
}
