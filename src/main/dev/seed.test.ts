import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMPORTANT_SPLIT_ID, OTHER_SPLIT_ID } from '../../shared/splits'
import { openDatabase } from '../db'
import { getSplitState } from '../splits'
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
    // Built here rather than read from e2e/fixtures: the e2e suite derives its
    // own readiness seeds, and this test only needs two accounts at different
    // checkpoints.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'attn-seed-'))
    const fixturePath = join(fixtureDir, 'two-accounts.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        accounts: [
          { account: 'ready@attn.test', splitSetup: true, threads: [] },
          { account: 'syncing@attn.test', splitSetup: true, backfillCursor: 'bodies', threads: [] }
        ]
      })
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
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('seeds fixture split rules in order, ahead of Important, with Other last', () => {
    const db = openDatabase(':memory:')
    const fixtureDir = mkdtempSync(join(tmpdir(), 'attn-seed-'))
    const fixturePath = join(fixtureDir, 'split-rules.json')
    writeFileSync(
      fixturePath,
      JSON.stringify({
        account: 'rules@attn.test',
        splitRules: [
          {
            id: 'preset:calendar',
            name: 'Calendar',
            operator: 'any',
            conditions: [{ type: 'attachmentFilenameSuffix', value: '.ics' }],
            notify: false
          },
          {
            id: 'preset:github',
            name: 'GitHub',
            operator: 'any',
            conditions: [{ type: 'senderDomain', value: 'github.com' }],
            notify: true
          }
        ],
        threads: []
      })
    )
    try {
      loadSeed(db, fixturePath)
      const expected = [
        ['preset:calendar', 'custom', false],
        ['preset:github', 'custom', true],
        [IMPORTANT_SPLIT_ID, 'base', true],
        [OTHER_SPLIT_ID, 'fallback', false]
      ]
      const listed = (): unknown[] =>
        getSplitState(db, 'rules@attn.test').splits.map((split) => [split.id, split.kind, split.notify])
      expect(listed()).toEqual(expected)

      // `reloadSeed` replays the fixture into the same profile.
      loadSeed(db, fixturePath)
      expect(listed()).toEqual(expected)
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
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
  it('returns only cached or remote snapshots configured for the exact Gmail query', () => {
    const fixturePath = fileURLToPath(new URL('../../../e2e/fixtures/seed-search.json', import.meta.url))

    expect(readSeedRemoteThreadIds(fixturePath, 'serveronlyneedle -in:drafts')).toEqual([
      't-search-server-only'
    ])
    expect(readSeedRemoteThreadIds(fixturePath, 'visualsort -in:drafts')).toEqual([
      't-search-origin',
      't-search-return',
      't-search-acme'
    ])
    expect(readSeedRemoteThreadIds(fixturePath, 'unmapped -in:drafts')).toEqual([])
  })
})
