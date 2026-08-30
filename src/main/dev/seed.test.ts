import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db'
import { loadSeed, readSeedRemoteThreadIds, resolveInternalDate } from './seed'

const base = { id: 'm1', from: 'a@b.test', to: 'c@d.test', subject: 's' }

describe('resolveInternalDate', () => {
  it('passes absolute stamps through untouched', () => {
    expect(resolveInternalDate({ ...base, internalDate: '1754800000000' })).toBe('1754800000000')
  })

  it('anchors relative ages to local midnight, not the clock', () => {
    const morning = new Date(2026, 7, 12, 6, 30).getTime()
    const evening = new Date(2026, 7, 12, 23, 30).getTime()
    const message = { ...base, receivedDaysAgo: 1, receivedAt: '16:20' }
    const expected = String(new Date(2026, 7, 11, 16, 20).getTime())
    // Same fixture, opposite ends of the day: a day-anchored stamp cannot drift
    // across a date-group boundary just because the suite ran early or late.
    expect(resolveInternalDate(message, morning)).toBe(expected)
    expect(resolveInternalDate(message, evening)).toBe(expected)
  })

  it('defaults to 09:00 when no wall-clock time is given', () => {
    const now = new Date(2026, 7, 12, 6, 30).getTime()
    expect(resolveInternalDate({ ...base, receivedDaysAgo: 0 }, now)).toBe(
      String(new Date(2026, 7, 12, 9, 0).getTime())
    )
  })

  it('rejects a message carrying neither form', () => {
    expect(() => resolveInternalDate({ ...base })).toThrow(/internalDate or receivedDaysAgo/)
  })

  it('rejects an unparseable wall-clock time', () => {
    expect(() => resolveInternalDate({ ...base, receivedDaysAgo: 0, receivedAt: 'noon' })).toThrow(
      /receivedAt/
    )
  })
})

describe('loadSeed', () => {
  it('keeps each account backfill checkpoint independent', () => {
    const db = openDatabase(':memory:')
    const fixturePath = fileURLToPath(
      new URL('../../../e2e/fixtures/seed-two-accounts-inbox-ready.json', import.meta.url)
    )
    try {
      expect(loadSeed(db, fixturePath).accountIds).toEqual(['ready@attn.test', 'syncing@attn.test'])
      expect(
        db
          .prepare(
            `SELECT account_id, backfill_cursor, split_metadata_cursor
             FROM sync_state ORDER BY account_id`
          )
          .all()
      ).toEqual([
        { account_id: 'ready@attn.test', backfill_cursor: 'done', split_metadata_cursor: 'done' },
        { account_id: 'syncing@attn.test', backfill_cursor: 'bodies', split_metadata_cursor: 'done' }
      ])
    } finally {
      db.close()
    }
  })

  it('applies one authoritative label catalog and reports only final-state changes', () => {
    const db = openDatabase(':memory:')
    const fixturePath = fileURLToPath(new URL('../../../e2e/fixtures/seed-inbox.json', import.meta.url))
    try {
      expect(loadSeed(db, fixturePath).labelsChanged).toBe(true)
      expect(
        loadSeed(db, fixturePath, {
          labels: [{ id: 'Label_2', name: 'active projects', type: 'user' }]
        }).labelsChanged
      ).toBe(true)
      expect(db.prepare('SELECT id, name FROM labels').all()).toEqual([
        { id: 'Label_2', name: 'active projects' }
      ])

      expect(loadSeed(db, fixturePath).labelsChanged).toBe(true)
      expect(loadSeed(db, fixturePath).labelsChanged).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('readSeedRemoteThreadIds', () => {
  it('returns only the remote snapshots configured for the exact Gmail query', () => {
    const fixturePath = fileURLToPath(new URL('../../../e2e/fixtures/seed-search.json', import.meta.url))

    expect(readSeedRemoteThreadIds(fixturePath, 'serveronlyneedle -in:drafts')).toEqual([
      't-search-server-only'
    ])
    expect(readSeedRemoteThreadIds(fixturePath, 'visualsort -in:drafts')).toEqual([])
  })
})
