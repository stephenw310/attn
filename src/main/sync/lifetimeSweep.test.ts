import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import type { GmailThread } from '../gmail/parse'
import { fakeMailProvider, fakeSchedulerTime } from '../testing/fakes'
import { type LifetimeSweepCallbacks, planLifetimeSweepStart, runLifetimeSweep } from './lifetimeSweep'
import type { MailProvider } from './provider'

// A spy that calls the real writer: the sweep's persistence options stay
// assertable while every read and write goes through real SQLite, the way the
// other sync suites work.
const mocks = vi.hoisted(() => ({ persistThread: vi.fn() }))

vi.mock('./persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persist')>()
  mocks.persistThread.mockImplementation(actual.persistThread)
  return { ...actual, persistThread: mocks.persistThread }
})

const ACCOUNT = 'test@example.com'

/** What Gmail returns for `format: 'metadata'`: headers, no body parts. */
function metadataThread(id: string): GmailThread {
  return {
    id,
    messages: [
      {
        id: `m-${id}`,
        threadId: id,
        labelIds: ['INBOX'],
        internalDate: '1000',
        snippet: `Snippet ${id}`,
        payload: {
          headers: [
            { name: 'From', value: 'Sender <sender@example.com>' },
            { name: 'Subject', value: `Subject ${id}` }
          ]
        }
      }
    ]
  }
}

function store(cursor: string | null, storedIds: readonly string[] = [], threadsDone = 0): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO sync_state (account_id, sweep_cursor, sweep_threads_done) VALUES (?, ?, ?)').run(
    ACCOUNT,
    cursor,
    threadsDone
  )
  const insert = db.prepare(
    'INSERT INTO threads (account_id, id, last_msg_at, is_inbox_visible) VALUES (?, ?, 1000, 0)'
  )
  db.transaction(() => {
    for (const id of storedIds) insert.run(ACCOUNT, id)
  })()
  return db
}

function storedIds(db: Db): string[] {
  return (
    db.prepare('SELECT id FROM threads WHERE account_id = ? ORDER BY id').all(ACCOUNT) as {
      id: string
    }[]
  ).map((row) => row.id)
}

function sweepState(db: Db): { cursor: string | null; done: number } {
  const row = db
    .prepare('SELECT sweep_cursor, sweep_threads_done FROM sync_state WHERE account_id = ?')
    .get(ACCOUNT) as { sweep_cursor: string | null; sweep_threads_done: number }
  return { cursor: row.sweep_cursor, done: row.sweep_threads_done }
}

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return fakeMailProvider({
    getProfile: vi.fn(async () => ({
      emailAddress: ACCOUNT,
      historyId: '101',
      threadsTotal: 50,
      messagesTotal: 70
    })),
    getThread: vi.fn(async (id: string) => metadataThread(id)),
    ...overrides
  })
}

function callbacks(): LifetimeSweepCallbacks & {
  onProgress: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onProgress: vi.fn(), onError: vi.fn() }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const NO_PAUSE = { requestIntervalMs: 0, pagePauseMs: 0 }

afterEach(() => {
  vi.useRealTimers()
  mocks.persistThread.mockClear()
})

describe('lifetime sweep cursor routing', () => {
  it('routes fresh, resumed, and completed cursors', () => {
    expect(planLifetimeSweepStart(null)).toEqual({ kind: 'run', initialize: true })
    expect(planLifetimeSweepStart('lifetime')).toEqual({ kind: 'run', initialize: false })
    expect(planLifetimeSweepStart('lifetime:page-2')).toEqual({
      kind: 'run',
      pageToken: 'page-2',
      initialize: false
    })
    expect(planLifetimeSweepStart('done')).toEqual({ kind: 'skip' })
    expect(planLifetimeSweepStart('capped:lifetime')).toEqual({ kind: 'run', initialize: false })
    expect(planLifetimeSweepStart('capped:lifetime:page-2')).toEqual({
      kind: 'run',
      pageToken: 'page-2',
      initialize: false
    })
    expect(() => planLifetimeSweepStart('sent:page-2')).toThrow('Invalid lifetime sweep cursor')
  })
})

describe('lifetime header indexing', () => {
  it('uses an unfiltered listing, skips stored ids, and stores hidden metadata rows', async () => {
    const db = store(null, ['stored'])
    try {
      const mail = provider({ listThreadIds: vi.fn(async () => ({ threadIds: ['stored', 'old'] })) })
      const events = callbacks()

      const result = await runLifetimeSweep(db, mail, ACCOUNT, events, NO_PAUSE)

      expect(mail.listThreadIds).toHaveBeenCalledWith({
        pageToken: undefined,
        priority: 'background'
      })
      expect(mail.getThread).toHaveBeenCalledOnce()
      expect(mail.getThread).toHaveBeenCalledWith('old', {
        format: 'metadata',
        priority: 'background'
      })
      expect(mocks.persistThread).toHaveBeenCalledWith(expect.anything(), ACCOUNT, metadataThread('old'), {
        metadataOnly: true,
        inboxVisibility: 'hide'
      })
      // Stored for lifetime recall, outside the bounded Inbox surface.
      expect(storedIds(db)).toEqual(['old', 'stored'])
      expect(
        db.prepare('SELECT is_inbox_visible FROM threads WHERE account_id = ? AND id = ?').get(ACCOUNT, 'old')
      ).toEqual({ is_inbox_visible: 0 })
      expect(sweepState(db)).toEqual({ cursor: 'done', done: 2 })
      expect(result).toMatchObject({ threadCount: 2, quotaWaitMs: 0 })
      expect(events.onError).not.toHaveBeenCalled()
      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ threadsDone: 2, threadsTotal: 50, messagesTotal: 70 })
      )
    } finally {
      db.close()
    }
  })

  it('stops at the conversation cap without discarding its cursor or making requests', async () => {
    // The walk is newest first, so a cap keeps the newest conversations and
    // leaves the rest to server search. Two already stored, cap of two: the
    // third must never be fetched.
    const db = store(null, ['newest', 'next'])
    try {
      const mail = provider({
        listThreadIds: vi.fn(async () => ({ threadIds: ['newest', 'next', 'older'] }))
      })
      const events = callbacks()

      const result = await runLifetimeSweep(db, mail, ACCOUNT, events, { ...NO_PAUSE, threadCap: 2 })

      expect(mail.getThread).not.toHaveBeenCalled()
      expect(mail.getProfile).not.toHaveBeenCalled()
      expect(mail.listThreadIds).not.toHaveBeenCalled()
      expect(mocks.persistThread).not.toHaveBeenCalled()
      expect(sweepState(db).cursor).toBe('capped:lifetime')
      expect(result).toMatchObject({ threadCount: 0 })
      expect(events.onError).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it.each([4, 0])(
    'resumes a partial page when the cap changes to %i without double-counting ids',
    async (cap) => {
      const db = store('lifetime:page-2', ['first', 'second'], 2)
      try {
        const mail = provider({
          listThreadIds: vi.fn(async ({ pageToken } = {}) =>
            pageToken === 'page-2'
              ? { threadIds: ['third', 'fourth'], nextPageToken: 'page-3' }
              : { threadIds: ['fifth'] }
          )
        })
        const events = callbacks()
        const run = (threadCap: number) =>
          runLifetimeSweep(db, mail, ACCOUNT, events, { ...NO_PAUSE, threadCap })

        await run(3)
        expect(storedIds(db)).toEqual(['first', 'second', 'third'])
        expect(sweepState(db)).toEqual({ cursor: 'capped:lifetime:page-2', done: 2 })
        vi.mocked(mail.getThread).mockClear()
        vi.mocked(mail.listThreadIds).mockClear()
        vi.mocked(mail.getProfile).mockClear()
        await run(3)
        await run(2)
        expect(mail.getThread).not.toHaveBeenCalled()
        expect(mail.listThreadIds).not.toHaveBeenCalled()
        expect(mail.getProfile).not.toHaveBeenCalled()

        await run(cap)
        expect(mail.listThreadIds).toHaveBeenNthCalledWith(1, {
          pageToken: 'page-2',
          priority: 'background'
        })
        expect(vi.mocked(mail.getThread).mock.calls.map(([id]) => id)).toEqual(
          cap === 0 ? ['fourth', 'fifth'] : ['fourth']
        )
        expect(sweepState(db)).toEqual({
          cursor: cap === 0 ? 'done' : 'capped:lifetime:page-3',
          done: cap === 0 ? 5 : 4
        })
        expect(events.onError).not.toHaveBeenCalled()
      } finally {
        db.close()
      }
    }
  )

  it('stores the whole account when the cap is disabled', async () => {
    const db = store(null, ['stored'])
    try {
      const mail = provider({ listThreadIds: vi.fn(async () => ({ threadIds: ['stored', 'older'] })) })

      await runLifetimeSweep(db, mail, ACCOUNT, callbacks(), { ...NO_PAUSE, threadCap: 0 })

      expect(mail.getThread).toHaveBeenCalledWith('older', expect.anything())
      expect(storedIds(db)).toEqual(['older', 'stored'])
    } finally {
      db.close()
    }
  })

  it('does not write or advance the cursor after cancellation during a metadata request', async () => {
    const db = store('lifetime')
    try {
      let resolveThread!: (thread: GmailThread) => void
      const thread = new Promise<GmailThread>((resolve) => {
        resolveThread = resolve
      })
      let active = true
      const mail = provider({
        listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
        getThread: vi.fn(() => thread)
      })

      const run = runLifetimeSweep(db, mail, ACCOUNT, callbacks(), {
        ...NO_PAUSE,
        shouldContinue: () => active
      })
      await flush()
      active = false
      resolveThread(metadataThread('old'))

      await expect(run).resolves.toBeNull()
      expect(mocks.persistThread).not.toHaveBeenCalled()
      expect(storedIds(db)).toEqual([])
      expect(sweepState(db).cursor).toBe('lifetime')
    } finally {
      db.close()
    }
  })

  it('counts stored threads once a page, never on a foreground-yield tick', async () => {
    vi.useFakeTimers()
    const inner = store('lifetime')
    try {
      let foregroundBusy = true
      let counts = 0
      // Counting every stored thread id scans the account: on a 400,000-thread
      // store the 250 ms yield loop would repeat that scan while foreground work
      // holds the single utility-process connection.
      const countingStatement = (statement: ReturnType<Db['prepare']>): ReturnType<Db['prepare']> =>
        new Proxy(statement, {
          get(target, property, receiver) {
            if (property === 'get') {
              return (accountId: string) => {
                counts++
                return target.get(accountId)
              }
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      const db = new Proxy(inner, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (sql: string) => {
              const statement = target.prepare(sql)
              return sql.startsWith('SELECT COUNT(*) AS count FROM threads')
                ? countingStatement(statement)
                : statement
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as Db
      const listThreadIds = vi
        .fn()
        .mockResolvedValueOnce({ threadIds: [], nextPageToken: 'page-2' })
        .mockResolvedValueOnce({ threadIds: [] })
      const events = callbacks()

      const run = runLifetimeSweep(db, provider({ listThreadIds }), ACCOUNT, events, {
        requestIntervalMs: 0,
        pagePauseMs: 1_000,
        foregroundYieldMs: 250,
        shouldYield: () => foregroundBusy
      })

      await flush()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'foreground-yield', waitMs: 250 })
      )
      expect(events.onProgress.mock.calls.length).toBeGreaterThan(3)
      expect(counts).toBe(1)

      foregroundBusy = false
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(run).resolves.toMatchObject({ threadCount: 0 })
      expect(counts).toBe(3)
    } finally {
      inner.close()
    }
  })

  it.each([
    { threadCap: undefined, expectedEtaMs: 7_200 },
    { threadCap: 4, expectedEtaMs: 2_400 },
    { threadCap: 20, expectedEtaMs: 7_200 },
    { threadCap: 0, expectedEtaMs: 7_200 },
    { threadCap: 1, expectedEtaMs: undefined }
  ])('estimates remaining metadata work with cap $threadCap', async ({ threadCap, expectedEtaMs }) => {
    const db = store('lifetime')
    try {
      const time = fakeSchedulerTime()
      const events = callbacks()

      await runLifetimeSweep(
        db,
        provider({
          getProfile: vi.fn(async () => {
            time.set(100)
            return { emailAddress: ACCOUNT, historyId: '101', threadsTotal: 10 }
          }),
          listThreadIds: vi
            .fn()
            .mockImplementationOnce(async () => {
              time.set(200)
              return { threadIds: ['old'], nextPageToken: 'page-2', resultSizeEstimate: 10 }
            })
            .mockResolvedValueOnce({ threadIds: [] }),
          getThread: vi.fn(async () => {
            time.set(1_000)
            return metadataThread('old')
          })
        }),
        ACCOUNT,
        events,
        { ...NO_PAUSE, time, threadCap }
      )

      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          threadsDone: 1,
          threadsTotal: 10,
          elapsedMs: 1_000,
          threadsPerMinute: 60
        })
      )
      // Listing takes 200ms; only the 800ms metadata fetch determines the pace.
      // Keep the full account total for coverage, but time only the work before
      // the cap or account end, whichever comes first. At the cap, no ETA remains.
      const indexed = events.onProgress.mock.calls.find(([event]) => event.threadsDone === 1)?.[0]
      expect(indexed?.etaMs).toBe(expectedEtaMs)
    } finally {
      db.close()
    }
  })

  it('reports actual weighted-limiter wait separately from the sweep duty cycle', async () => {
    const db = store('lifetime')
    try {
      let quotaWaitMs = 0
      const events = callbacks()
      const mail = provider({
        listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
        getThread: vi.fn(async (id: string) => {
          quotaWaitMs = 250
          return metadataThread(id)
        }),
        quotaMetrics: () => ({ requests: 2, units: 50, waitMs: quotaWaitMs })
      })

      const result = await runLifetimeSweep(db, mail, ACCOUNT, events, NO_PAUSE)

      expect(result).toMatchObject({ threadCount: 1, quotaWaitMs: 250 })
      expect(events.onProgress).toHaveBeenCalledWith(expect.objectContaining({ quotaWaitMs: 250 }))
    } finally {
      db.close()
    }
  })

  it('does not count a foreground write that lands during a metadata request as sweep throughput', async () => {
    const db = store('lifetime')
    try {
      let resolveThread: ((thread: GmailThread) => void) | undefined
      const getThread = vi.fn(
        () =>
          new Promise<GmailThread>((resolve) => {
            resolveThread = resolve
          })
      )
      const events = callbacks()

      const run = runLifetimeSweep(
        db,
        provider({
          getProfile: vi.fn(async () => ({
            emailAddress: ACCOUNT,
            historyId: '101',
            threadsTotal: 10
          })),
          listThreadIds: vi.fn(async () => ({ threadIds: ['old'] })),
          getThread
        }),
        ACCOUNT,
        events,
        NO_PAUSE
      )

      await vi.waitFor(() => expect(getThread).toHaveBeenCalledOnce())
      // Foreground history work indexes the same thread while the metadata
      // request is still in flight.
      db.prepare('INSERT INTO threads (account_id, id, last_msg_at) VALUES (?, ?, 1000)').run(ACCOUNT, 'old')
      resolveThread?.(metadataThread('old'))

      await expect(run).resolves.toMatchObject({ threadCount: 1 })
      expect(mocks.persistThread).not.toHaveBeenCalled()
      expect(events.onProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadsDone: 1, threadsTotal: 10 })
      )
      expect(events.onProgress.mock.calls.every(([event]) => event.etaMs === undefined)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('persists processed listing progress so a resumed page does not restart at zero', async () => {
    const existingIds = Array.from({ length: 500 }, (_, index) => `stored-${index}`)
    const db = store('lifetime:page-2', existingIds, 500)
    try {
      const events = callbacks()

      await runLifetimeSweep(
        db,
        provider({
          getProfile: vi.fn(async () => ({
            emailAddress: ACCOUNT,
            historyId: '101',
            threadsTotal: 1_000
          })),
          listThreadIds: vi
            .fn()
            .mockResolvedValueOnce({ threadIds: [], nextPageToken: 'page-3' })
            .mockResolvedValueOnce({ threadIds: [] })
        }),
        ACCOUNT,
        events,
        NO_PAUSE
      )

      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ threadsDone: 500, threadsTotal: 1_000 })
      )
      expect(sweepState(db)).toEqual({ cursor: 'done', done: 500 })
    } finally {
      db.close()
    }
  })

  it('uses the account total and unique local rows instead of a page result estimate', async () => {
    const db = store('lifetime', ['stage-one', 'all-mail', 'spam'])
    try {
      const events = callbacks()

      await runLifetimeSweep(
        db,
        provider({
          getProfile: vi.fn(async () => ({
            emailAddress: ACCOUNT,
            historyId: '101',
            threadsTotal: 50_000
          })),
          listThreadIds: vi
            .fn()
            .mockResolvedValueOnce({
              threadIds: [],
              nextPageToken: 'page-2',
              resultSizeEstimate: 201
            })
            .mockResolvedValueOnce({ threadIds: [] })
        }),
        ACCOUNT,
        events,
        NO_PAUSE
      )

      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          threadsDone: 3,
          threadsTotal: 50_000,
          reason: 'quota-wait'
        })
      )
      const waiting = events.onProgress.mock.calls.find(([event]) => event.reason === 'quota-wait')?.[0]
      expect(waiting.threadsTotal).not.toBe(201)
    } finally {
      db.close()
    }
  })

  it('keeps progress indeterminate when the account profile omits its thread total', async () => {
    const db = store('lifetime', ['stored'])
    try {
      const events = callbacks()

      await runLifetimeSweep(
        db,
        provider({
          getProfile: vi.fn(async () => ({ emailAddress: ACCOUNT, historyId: '101' })),
          listThreadIds: vi.fn(async () => ({ threadIds: [], resultSizeEstimate: 201 }))
        }),
        ACCOUNT,
        events,
        NO_PAUSE
      )

      expect(events.onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ threadsDone: 1, reason: 'running' })
      )
      expect(events.onProgress.mock.calls.every(([event]) => !('threadsTotal' in event))).toBe(true)
      expect(events.onProgress.mock.calls.every(([event]) => !('etaMs' in event))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('does not expose hidden persistence as a visible-mail change signal', async () => {
    const db = store('lifetime')
    try {
      const events = callbacks()

      await runLifetimeSweep(
        db,
        provider({ listThreadIds: vi.fn(async () => ({ threadIds: ['chat'] })) }),
        ACCOUNT,
        events,
        NO_PAUSE
      )

      expect(storedIds(db)).toEqual(['chat'])
      expect(events.onProgress.mock.calls.every(([event]) => !('mailChanged' in event))).toBe(true)
    } finally {
      db.close()
    }
  })
})
