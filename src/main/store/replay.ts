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
    try {
      const payload = JSON.parse(row.payload) as { add?: unknown; remove?: unknown }
      const add = stringArray(payload.add) ? payload.add : []
      const remove = stringArray(payload.remove) ? payload.remove : []
      applyThreadDelta(db, accountId, { threadId, add, remove })
    } catch {
      // Malformed durable intent is handled by the executor; don't block sync.
    }
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
