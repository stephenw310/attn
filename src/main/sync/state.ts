import type { SyncState } from '../../shared/mail'

/** Avoid renderer churn when a poll reports the state it already published. */
export function sameSyncState(left: SyncState, right: SyncState): boolean {
  if (left.phase !== right.phase) return false
  if (left.phase === 'syncing' && right.phase === 'syncing') {
    return (
      left.stage === right.stage &&
      left.threadsDone === right.threadsDone &&
      left.stageThreadsDone === right.stageThreadsDone &&
      left.stageThreadsTotal === right.stageThreadsTotal &&
      left.elapsedMs === right.elapsedMs &&
      left.stageElapsedMs === right.stageElapsedMs &&
      left.threadsPerMinute === right.threadsPerMinute &&
      left.stageThreadsPerMinute === right.stageThreadsPerMinute &&
      left.quotaWaitMs === right.quotaWaitMs &&
      left.firstReadableMs === right.firstReadableMs &&
      left.interactiveReadyMs === right.interactiveReadyMs
    )
  }
  if (left.phase === 'indexing' && right.phase === 'indexing') {
    return (
      left.stage === right.stage &&
      left.threadsDone === right.threadsDone &&
      left.threadsTotal === right.threadsTotal &&
      left.messagesTotal === right.messagesTotal &&
      left.etaMs === right.etaMs &&
      left.elapsedMs === right.elapsedMs &&
      left.threadsPerMinute === right.threadsPerMinute &&
      left.quotaWaitMs === right.quotaWaitMs &&
      left.reason === right.reason &&
      left.waitMs === right.waitMs &&
      left.message === right.message
    )
  }
  if (left.phase === 'offline' && right.phase === 'offline') {
    return left.message === right.message
  }
  if (left.phase === 'error' && right.phase === 'error') {
    return left.message === right.message
  }
  // 'idle' and 'checking' carry no payload, so matching phases are identical.
  return true
}
