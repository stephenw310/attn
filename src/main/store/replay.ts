import { decodeLabelDelta } from '../actions/queuePayload'
import type { Db } from '../db'
import { applyThreadDelta } from './mutate'

interface PendingRow {
  payload: string
}

/** Reapply local intent after a server snapshot so pending actions always win. */
export function replayPendingThreadDeltas(db: Db, accountId: string, threadId: string): void {
  const rows = db
    .prepare(
      `SELECT payload FROM action_queue
       WHERE account_id = ? AND thread_id = ? AND state IN ('pending', 'inflight') ORDER BY id`
    )
    .all(accountId, threadId) as PendingRow[]
  for (const row of rows) {
    let delta: ReturnType<typeof decodeLabelDelta>
    try {
      delta = decodeLabelDelta(row.payload)
    } catch {
      // The executor repairs malformed rows from an authoritative refetch.
      // One corrupt later row must not roll back persistence for this snapshot.
      continue
    }
    applyThreadDelta(db, accountId, { threadId, add: delta.add, remove: delta.remove })
  }
}
