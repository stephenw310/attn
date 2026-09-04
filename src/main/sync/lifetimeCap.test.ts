import { describe, expect, it } from 'vitest'
import { DEFAULT_LIFETIME_THREAD_CAP } from '../../shared/settings'
import { type Db, openDatabase } from '../db'
import { purgeAccountRows } from '../db/purgeAccount'
import { readAccountSetting } from '../settings'
import {
  applyLifetimeCapChange,
  capExpandsCoverage,
  effectiveLifetimeThreadCap,
  LIFETIME_CAP_SETTING,
  type LifetimeChainControl,
  storedLifetimeThreadCap
} from './lifetimeCap'

const ACCOUNT = 'user@attn.test'
const OTHER = 'other@attn.test'

function storeWith(cursors: { sweep?: string | null; attachment?: string | null } = {}): Db {
  const db = openDatabase(':memory:')
  for (const accountId of [ACCOUNT, OTHER]) {
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(accountId, accountId)
    db.prepare('INSERT INTO sync_state (account_id, sweep_cursor, attachment_cursor) VALUES (?, ?, ?)').run(
      accountId,
      cursors.sweep ?? null,
      cursors.attachment ?? null
    )
  }
  return db
}

function recordingControl(): LifetimeChainControl & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    invalidateLifetimeChain: () => calls.push('invalidate'),
    restartLifetimeChain: () => calls.push('restart')
  }
}

function cursors(db: Db, accountId = ACCOUNT): { sweep: string | null; attachment: string | null } {
  const row = db
    .prepare('SELECT sweep_cursor, attachment_cursor FROM sync_state WHERE account_id = ?')
    .get(accountId) as { sweep_cursor: string | null; attachment_cursor: string | null }
  return { sweep: row.sweep_cursor, attachment: row.attachment_cursor }
}

describe('storedLifetimeThreadCap', () => {
  it('falls back to the compile-time default when absent or corrupt', () => {
    const db = storeWith()
    expect(storedLifetimeThreadCap(db, ACCOUNT)).toBeNull()
    expect(effectiveLifetimeThreadCap(db, ACCOUNT)).toBe(DEFAULT_LIFETIME_THREAD_CAP)
    for (const corrupt of ['abc', '-5', '1.5', String(Number.MAX_SAFE_INTEGER + 2)]) {
      db.prepare('INSERT OR REPLACE INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(
        ACCOUNT,
        LIFETIME_CAP_SETTING,
        corrupt
      )
      expect(storedLifetimeThreadCap(db, ACCOUNT)).toBeNull()
    }
  })

  it('reads an override per account, 0 meaning All mail', () => {
    const db = storeWith()
    applyLifetimeCapChange(db, null, ACCOUNT, 2_000)
    expect(effectiveLifetimeThreadCap(db, ACCOUNT)).toBe(2_000)
    expect(effectiveLifetimeThreadCap(db, OTHER)).toBe(DEFAULT_LIFETIME_THREAD_CAP)
    applyLifetimeCapChange(db, null, ACCOUNT, 0)
    expect(effectiveLifetimeThreadCap(db, ACCOUNT)).toBe(0)
  })
})

describe('capExpandsCoverage', () => {
  it('treats All mail as the widest and compares numbers otherwise', () => {
    expect(capExpandsCoverage(400_000, 0)).toBe(true)
    expect(capExpandsCoverage(0, 400_000)).toBe(false)
    expect(capExpandsCoverage(0, 0)).toBe(false)
    expect(capExpandsCoverage(2_000, 5_000)).toBe(true)
    expect(capExpandsCoverage(5_000, 2_000)).toBe(false)
    expect(capExpandsCoverage(5_000, 5_000)).toBe(false)
  })
})

describe('applyLifetimeCapChange', () => {
  it('persists, invalidates the old run first, and restarts only that chain work', () => {
    const db = storeWith({ sweep: 'capped:lifetime:page-4', attachment: 'done' })
    const control = recordingControl()
    applyLifetimeCapChange(db, control, ACCOUNT, 10_000)
    expect(control.calls).toEqual(['invalidate', 'restart'])
    expect(storedLifetimeThreadCap(db, ACCOUNT)).toBe(10_000)
    // Lowering from the default is not an expansion: the sweep cursor and
    // every unrelated cursor stay exactly as they were.
    expect(cursors(db)).toEqual({ sweep: 'capped:lifetime:page-4', attachment: 'done' })
  })

  it('expanding a reached limit restarts any started attachment pass atomically', () => {
    const db = storeWith({ sweep: 'capped:lifetime:page-4', attachment: 'done' })
    applyLifetimeCapChange(db, recordingControl(), ACCOUNT, 500_000)
    expect(cursors(db)).toEqual({ sweep: 'capped:lifetime:page-4', attachment: 'attachments' })
    // A partial pass has the same hole as a completed one: its walked pages
    // precede the ids the expansion imports, so resuming from the saved token
    // would leave those threads unflagged forever (PR #101 review).
    const midRun = storeWith({ sweep: 'capped:lifetime:page-2', attachment: 'attachments:tok' })
    applyLifetimeCapChange(midRun, recordingControl(), ACCOUNT, 500_000)
    expect(cursors(midRun).attachment).toBe('attachments')
    // All mail from a reached limit behaves the same.
    const unlimited = storeWith({ sweep: 'capped:lifetime', attachment: 'done' })
    applyLifetimeCapChange(unlimited, recordingControl(), ACCOUNT, 0)
    expect(cursors(unlimited).attachment).toBe('attachments')
    // A pass that never started has nothing to restart: the chain reaches it
    // after the expanded sweep on its own.
    const unstarted = storeWith({ sweep: 'capped:lifetime:page-2', attachment: null })
    applyLifetimeCapChange(unstarted, recordingControl(), ACCOUNT, 500_000)
    expect(cursors(unstarted).attachment).toBeNull()
  })

  it('leaves an exhausted sweep alone', () => {
    // A truly exhausted listing stays done: raising the cap fetches nothing
    // and must not re-arm the attachment pass either.
    const done = storeWith({ sweep: 'done', attachment: 'done' })
    const control = recordingControl()
    applyLifetimeCapChange(done, control, ACCOUNT, 500_000)
    expect(cursors(done)).toEqual({ sweep: 'done', attachment: 'done' })
    expect(control.calls).toEqual(['invalidate', 'restart'])
  })

  it('skips chain work for unchanged values and for same-effective rewrites', () => {
    const db = storeWith({ sweep: 'capped:lifetime', attachment: 'done' })
    const unchanged = recordingControl()
    applyLifetimeCapChange(db, unchanged, ACCOUNT, null)
    expect(unchanged.calls).toEqual([])

    // Writing the default explicitly persists but schedules nothing: the
    // effective cap did not move, so there is no new historical work.
    const explicit = recordingControl()
    applyLifetimeCapChange(db, explicit, ACCOUNT, DEFAULT_LIFETIME_THREAD_CAP)
    expect(explicit.calls).toEqual([])
    expect(storedLifetimeThreadCap(db, ACCOUNT)).toBe(DEFAULT_LIFETIME_THREAD_CAP)
    expect(cursors(db).attachment).toBe('done')
  })

  it('reset to default removes the override row', () => {
    const db = storeWith()
    applyLifetimeCapChange(db, null, ACCOUNT, 2_000)
    applyLifetimeCapChange(db, null, ACCOUNT, null)
    expect(readAccountSetting(db, ACCOUNT, LIFETIME_CAP_SETTING)).toBeUndefined()
    expect(effectiveLifetimeThreadCap(db, ACCOUNT)).toBe(DEFAULT_LIFETIME_THREAD_CAP)
  })

  it('is removed by Delete-local-data and untouched for other accounts', () => {
    const db = storeWith()
    applyLifetimeCapChange(db, null, ACCOUNT, 2_000)
    applyLifetimeCapChange(db, null, OTHER, 7_000)
    purgeAccountRows(db, ACCOUNT)
    expect(readAccountSetting(db, ACCOUNT, LIFETIME_CAP_SETTING)).toBeUndefined()
    // Keep-local-data is the absence of a purge: the surviving account's
    // override (and a kept account's rows generally) stay for a re-add.
    expect(storedLifetimeThreadCap(db, OTHER)).toBe(7_000)
  })
})
