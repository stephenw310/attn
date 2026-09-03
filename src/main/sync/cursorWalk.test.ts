import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import { fakeSchedulerTime } from '../testing/fakes'
import { type CursorWalk, planCursorStart, runCursorWalk } from './cursorWalk'

const ACCOUNT = 'walker@example.test'
const PHASE = 'attachments'
// Any `sync_state` cursor column will do: the walk is told which one to use.
const COLUMN = 'attachment_cursor'

interface TestPage {
  ids: string[]
  next?: string
}

function store(cursor: string | null = null): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO sync_state (account_id, attachment_cursor) VALUES (?, ?)').run(ACCOUNT, cursor)
  return db
}

function cursorOf(db: Db): string | null {
  return (
    db.prepare(`SELECT ${COLUMN} AS cursor FROM sync_state WHERE account_id = ?`).get(ACCOUNT) as {
      cursor: string | null
    }
  ).cursor
}

/** A minimal walk: every page's ids are collected, nothing else happens. */
function walkOver(
  db: Db,
  pages: (token: string | undefined) => Promise<TestPage>,
  overrides: Partial<CursorWalk<TestPage, string[]>> = {}
): CursorWalk<TestPage, string[]> {
  const visited: string[] = []
  return {
    db,
    accountId: ACCOUNT,
    cursorColumn: COLUMN,
    phase: PHASE,
    parseCursor: (cursor) => planCursorStart(PHASE, cursor, 'test walk'),
    pagePauseMs: 0,
    foregroundYieldMs: 0,
    progress: () => {},
    onError: () => {},
    onSkip: () => [],
    listPage: (token) => pages(token),
    nextToken: (page) => page.next,
    onPage: async (page) => {
      visited.push(...page.ids)
    },
    onFinish: () => visited,
    ...overrides
  }
}

const expiredToken = (): GmailApiError => new GmailApiError(400, 'invalid page token')

afterEach(() => {
  vi.useRealTimers()
})

describe('cursor grammar', () => {
  it('routes fresh, resumed, and completed cursors', () => {
    expect(planCursorStart(PHASE, null, 'test walk')).toEqual({ kind: 'run', initialize: true })
    expect(planCursorStart(PHASE, PHASE, 'test walk')).toEqual({ kind: 'run', initialize: false })
    expect(planCursorStart(PHASE, `${PHASE}:page-2`, 'test walk')).toEqual({
      kind: 'run',
      token: 'page-2',
      initialize: false
    })
    expect(planCursorStart(PHASE, 'done', 'test walk')).toEqual({ kind: 'skip' })
    expect(() => planCursorStart(PHASE, 'sent:page-2', 'test walk')).toThrow(
      'Invalid test walk cursor: sent:page-2'
    )
    // A phase prefix with nothing after the colon is not a resume point.
    expect(() => planCursorStart(PHASE, `${PHASE}:`, 'test walk')).toThrow('Invalid test walk cursor')
  })

  it('costs nothing once the cursor says done', async () => {
    const db = store('done')
    try {
      const listPage = vi.fn(async () => ({ ids: [] }))
      const result = await runCursorWalk(
        walkOver(db, listPage, { onSkip: () => ['skipped'], stateColumns: ['sweep_threads_done'] })
      )

      expect(result).toEqual(['skipped'])
      expect(listPage).not.toHaveBeenCalled()
      expect(cursorOf(db)).toBe('done')
    } finally {
      db.close()
    }
  })
})

describe('page walk', () => {
  it('resumes from the durable token and checkpoints each page before the next', async () => {
    const db = store(`${PHASE}:page-2`)
    try {
      const cursorsSeen: (string | null)[] = []
      const tokens: (string | undefined)[] = []
      const listPage = vi.fn(async (token: string | undefined) => {
        tokens.push(token)
        cursorsSeen.push(cursorOf(db))
        return token === 'page-2' ? { ids: ['a'], next: 'page-3' } : { ids: ['b'] }
      })

      await expect(runCursorWalk(walkOver(db, listPage))).resolves.toEqual(['a', 'b'])

      expect(tokens).toEqual(['page-2', 'page-3'])
      // The second request only happens once the first page is durable.
      expect(cursorsSeen).toEqual([`${PHASE}:page-2`, `${PHASE}:page-3`])
      expect(cursorOf(db)).toBe('done')
    } finally {
      db.close()
    }
  })

  it('restarts the phase once when a saved page token has expired', async () => {
    const db = store(`${PHASE}:stale`)
    try {
      const restarts: string[] = []
      const tokens: (string | undefined)[] = []
      const listPage = vi.fn(async (token: string | undefined) => {
        tokens.push(token)
        if (token === 'stale') throw expiredToken()
        return { ids: ['a'] }
      })
      const onError = vi.fn()

      await expect(
        runCursorWalk(
          walkOver(db, listPage, {
            onError,
            onRestart: () => restarts.push(cursorOf(db) ?? '')
          })
        )
      ).resolves.toEqual(['a'])

      expect(tokens).toEqual(['stale', undefined])
      expect(restarts).toEqual([`${PHASE}:stale`])
      expect(onError).not.toHaveBeenCalled()
      expect(cursorOf(db)).toBe('done')
    } finally {
      db.close()
    }
  })

  it('reports a second failure instead of restarting again, leaving the cursor alone', async () => {
    const db = store(`${PHASE}:stale`)
    try {
      const listPage = vi.fn(async () => {
        throw expiredToken()
      })
      const onError = vi.fn()

      await expect(runCursorWalk(walkOver(db, listPage, { onError }))).resolves.toBeNull()

      expect(listPage).toHaveBeenCalledTimes(2)
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }))
      // The restart is durable, so the retried listing starts from the top.
      expect(cursorOf(db)).toBe(PHASE)
    } finally {
      db.close()
    }
  })

  it('reports a failure without advancing the cursor', async () => {
    const db = store(PHASE)
    try {
      const onError = vi.fn()
      const listPage = vi.fn(async () => {
        throw new GmailApiError(429, 'quota', true)
      })

      await expect(runCursorWalk(walkOver(db, listPage, { onError }))).resolves.toBeNull()

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }))
      expect(cursorOf(db)).toBe(PHASE)
    } finally {
      db.close()
    }
  })

  it('stops writing as soon as the run is cancelled', async () => {
    const db = store()
    try {
      let live = true
      const onError = vi.fn()
      const onPage = vi.fn()
      const listPage = vi.fn(async () => {
        live = false
        return { ids: ['a'], next: 'page-2' }
      })

      await expect(
        runCursorWalk(walkOver(db, listPage, { onError, onPage, shouldContinue: () => live }))
      ).resolves.toBeNull()

      expect(onPage).not.toHaveBeenCalled()
      expect(cursorOf(db)).toBeNull()
      expect(onError).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('does not checkpoint a page the body abandoned on cancellation', async () => {
    const db = store()
    try {
      let live = true
      const listPage = vi.fn(async () => ({ ids: ['a'], next: 'page-2' }))

      await expect(
        runCursorWalk(
          walkOver(db, listPage, {
            shouldContinue: () => live,
            onPage: async () => {
              live = false
            }
          })
        )
      ).resolves.toBeNull()

      expect(cursorOf(db)).toBeNull()
    } finally {
      db.close()
    }
  })
})

describe('pacing', () => {
  it('yields to foreground work and paces page boundaries on injected time', async () => {
    vi.useFakeTimers()
    const db = store()
    try {
      let foregroundBusy = true
      const progress = vi.fn()
      const listPage = vi
        .fn()
        .mockResolvedValueOnce({ ids: ['a'], next: 'page-2' })
        .mockResolvedValueOnce({ ids: ['b'] })
      const run = runCursorWalk(
        walkOver(db, listPage, {
          progress,
          pagePauseMs: 1_000,
          foregroundYieldMs: 250,
          shouldYield: () => foregroundBusy
        })
      )

      await Promise.resolve()
      expect(listPage).not.toHaveBeenCalled()
      expect(progress).toHaveBeenCalledWith('foreground-yield', 250)

      foregroundBusy = false
      await vi.advanceTimersByTimeAsync(250)
      expect(listPage).toHaveBeenCalledOnce()
      expect(progress).toHaveBeenCalledWith('quota-wait', 1_000)

      await vi.advanceTimersByTimeAsync(999)
      expect(listPage).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      await expect(run).resolves.toEqual(['a', 'b'])
      expect(cursorOf(db)).toBe('done')
    } finally {
      db.close()
    }
  })

  it('spaces requests by the request interval on the injected clock', async () => {
    vi.useFakeTimers()
    const db = store()
    try {
      const time = fakeSchedulerTime()
      const listPage = vi.fn(async (token: string | undefined) => {
        time.advance(20)
        return token ? { ids: ['b'] } : { ids: ['a'], next: 'page-2' }
      })
      const run = runCursorWalk(walkOver(db, listPage, { time, requestIntervalMs: 100 }))

      await vi.advanceTimersByTimeAsync(0)
      expect(listPage).toHaveBeenCalledOnce()
      // 20 ms of the interval was spent inside the request itself.
      await vi.advanceTimersByTimeAsync(79)
      expect(listPage).toHaveBeenCalledOnce()
      time.advance(80)
      await vi.advanceTimersByTimeAsync(1)
      expect(listPage).toHaveBeenCalledTimes(2)
      await expect(run).resolves.toEqual(['a', 'b'])
    } finally {
      db.close()
    }
  })

  it('leaves the pause silent for a walk with no quota to wait on', async () => {
    vi.useFakeTimers()
    const db = store()
    try {
      const progress = vi.fn()
      const listPage = vi
        .fn()
        .mockResolvedValueOnce({ ids: ['a'], next: 'page-2' })
        .mockResolvedValueOnce({ ids: ['b'] })
      const run = runCursorWalk(walkOver(db, listPage, { progress, pauseReason: null, pagePauseMs: 500 }))

      await vi.advanceTimersByTimeAsync(500)
      await expect(run).resolves.toEqual(['a', 'b'])
      expect(progress.mock.calls).toEqual([['running'], ['running']])
    } finally {
      db.close()
    }
  })
})

describe('checkpoint hooks', () => {
  it('commits a page own writes with its cursor and reports it afterwards', async () => {
    const db = store()
    try {
      const checkpoints: string[] = []
      const listPage = vi
        .fn()
        .mockResolvedValueOnce({ ids: ['a'], next: 'page-2' })
        .mockResolvedValueOnce({ ids: ['b'] })
      const rows: string[] = []

      await expect(
        runCursorWalk(
          walkOver(db, listPage, {
            commitPage: (page, applyCursor) => {
              db.transaction(() => {
                rows.push(...page.ids)
                applyCursor()
              })()
            },
            afterCheckpoint: (cursor) => {
              checkpoints.push(`${cursor}@${cursorOf(db)}`)
            }
          })
        )
      ).resolves.toEqual(['a', 'b'])

      expect(rows).toEqual(['a', 'b'])
      // Reported only once the cursor it names is durable.
      expect(checkpoints).toEqual([`${PHASE}:page-2@${PHASE}:page-2`, 'done@done'])
    } finally {
      db.close()
    }
  })

  it('creates the sync_state row when a pass may reach an account without one', async () => {
    const db = openDatabase(':memory:')
    try {
      const listPage = vi.fn(async () => ({ ids: ['a'] }))

      await expect(runCursorWalk(walkOver(db, listPage, { ensureSyncStateRow: true }))).resolves.toEqual([
        'a'
      ])

      expect(cursorOf(db)).toBe('done')
    } finally {
      db.close()
    }
  })

  it('can end the walk before its first page', async () => {
    const db = store()
    try {
      const listPage = vi.fn(async () => ({ ids: ['a'] }))

      await expect(
        runCursorWalk(walkOver(db, listPage, { onStart: async () => ({ stop: ['stopped'] }) }))
      ).resolves.toEqual(['stopped'])
      expect(listPage).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
