import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import {
  BACKGROUND_POLL_MS,
  type FetchedHistoryPlan,
  FOREGROUND_POLL_MS,
  fetchHistoryPlan,
  HistoryPoller,
  type HistoryPollerOptions,
  missingInboxThreadIds,
  planCycle,
  reconcileInboxMembership,
  reconcileLabelMembership,
  reconcilePurgeableMembership,
  runHistoryCycle
} from './poller'
import type { HistoryPage, HistoryRecord, MailProvider } from './provider'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/history-cycle.json', import.meta.url), 'utf8')
) as HistoryRecord[]

function providerFor(pages: HistoryPage[]): MailProvider {
  let page = 0
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'test@example.com', historyId: '1' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async (id) => ({ id, messages: [] })),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => pages[page++]),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: `thread-${id}` } }))
  }
}

function plan(refetchThreadIds: string[] = []): FetchedHistoryPlan {
  return { historyId: '11', refetchThreadIds, newMail: [], promoteInboxThreadIds: [] }
}

function checkpointDb(lastHistoryId = '10'): { db: Db; checkpoint: () => string } {
  let checkpoint = lastHistoryId
  const db = {
    prepare: (sql: string) => ({
      get: () => ({ last_history_id: checkpoint }),
      run: (next: unknown) => {
        if (sql.startsWith('UPDATE sync_state')) checkpoint = next as string
        return { changes: 1 }
      }
    })
  } as unknown as Db
  return { db, checkpoint: () => checkpoint }
}

function pollerOptions(overrides: Partial<HistoryPollerOptions> = {}): HistoryPollerOptions {
  return {
    db: {} as Db,
    accountId: 'test@example.com',
    provider: providerFor([{ history: [], historyId: '11' }]),
    isForeground: () => true,
    recoverExpiredHistory: vi.fn(async () => {}),
    onCycleComplete: vi.fn(),
    onError: vi.fn(),
    runCycle: vi.fn(async () => plan()),
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('history cycle planner', () => {
  it('dedupes every affected thread and identifies only inbound unread mail', () => {
    expect(planCycle(fixture)).toEqual({
      refetchThreadIds: ['t-label', 't-deleted', 't-inbound', 't-self', 't-read'],
      newMail: [{ threadId: 't-inbound', messageId: 'm-inbound' }],
      promoteInboxThreadIds: ['t-inbound', 't-self', 't-read']
    })
  })

  it('promotes a lifetime-hidden thread when Gmail explicitly adds it to Inbox', () => {
    expect(
      planCycle([
        {
          id: '12',
          labelsAdded: [{ message: { id: 'old-message', threadId: 'old-thread' }, labelIds: ['INBOX'] }]
        }
      ]).promoteInboxThreadIds
    ).toEqual(['old-thread'])
  })

  it('combines mixed pages and preserves 64-bit history ids', async () => {
    const provider = providerFor([
      { history: fixture.slice(0, 2), historyId: '9007199254740994', nextPageToken: 'page-2' },
      { history: fixture.slice(2), historyId: '9007199254740996' }
    ])
    const result = await fetchHistoryPlan(provider, '9007199254740992')
    expect(provider.listHistory).toHaveBeenNthCalledWith(2, '9007199254740992', 'page-2')
    expect(result.historyId).toBe('9007199254740996')
  })
})

describe('stateful history application', () => {
  it('persists surviving threads, removes 404s, and advances the checkpoint last', async () => {
    const { db, checkpoint } = checkpointDb()
    const provider = providerFor([
      {
        history: [
          {
            id: '11',
            messages: [
              { id: 'm1', threadId: 'keep' },
              { id: 'm2', threadId: 'gone' }
            ]
          }
        ],
        historyId: '11'
      }
    ])
    vi.mocked(provider.getThread)
      .mockResolvedValueOnce({ id: 'keep', messages: [] })
      .mockRejectedValueOnce(new GmailApiError(404, 'gone'))
    const persist = vi.fn(async () => {})
    const remove = vi.fn()

    await runHistoryCycle(db, 'test@example.com', provider, { persist, remove })

    expect(persist).toHaveBeenCalledWith({ id: 'keep', messages: [] })
    expect(remove).toHaveBeenCalledWith('gone')
    expect(checkpoint()).toBe('11')
  })

  it('reconciles against a complete server set without stripping older inbox mail', () => {
    const labels = new Set(['recent-missing', 'recent-present', 'old-unlisted'])
    const db = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('SELECT thread_id FROM thread_labels')) {
            return [...labels].map((thread_id) => ({ thread_id }))
          }
          return []
        },
        run: (...args: unknown[]) => {
          if (sql.startsWith('DELETE FROM thread_labels')) labels.delete(args[1] as string)
          return { changes: 1 }
        }
      }),
      transaction: (fn: () => void) => fn
    } as unknown as Db

    reconcileInboxMembership(db, 'test@example.com', ['recent-present', 'old-unlisted'])

    expect(labels).toEqual(new Set(['recent-present', 'old-unlisted']))
  })

  it('reconciles an arbitrary label without touching other memberships', () => {
    const stripped: unknown[][] = []
    const db = {
      prepare: (sql: string) => ({
        all: (...args: unknown[]) => {
          if (sql.includes('SELECT thread_id FROM thread_labels') && args[1] === 'SPAM') {
            return [{ thread_id: 'junk-kept' }, { thread_id: 'junk-gone' }]
          }
          return []
        },
        run: (...args: unknown[]) => {
          if (sql.startsWith('DELETE FROM thread_labels')) stripped.push(args)
          return { changes: 1 }
        }
      }),
      transaction: (fn: () => void) => fn
    } as unknown as Db

    const missing = reconcileLabelMembership(db, 'test@example.com', 'SPAM', ['junk-kept'])

    expect(missing).toEqual(['junk-gone'])
    expect(stripped).toEqual([['test@example.com', 'junk-gone', 'SPAM']])
  })

  it('replays a pending local delta after authoritative membership wins', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(
        `INSERT INTO threads (account_id, id, is_unread, is_starred)
         VALUES ('test@example.com', 'pending', 0, 0)`
      ).run()
      db.prepare(
        `INSERT INTO messages (account_id, id, thread_id, labels_json)
         VALUES ('test@example.com', 'message', 'pending', '["STARRED"]')`
      ).run()
      db.prepare(
        `INSERT INTO thread_labels (account_id, thread_id, label_id)
         VALUES ('test@example.com', 'pending', 'INBOX')`
      ).run()
      db.prepare(
        `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
         VALUES (
           'test@example.com',
           'modifyLabels',
           'pending',
           '{"add":["INBOX"],"remove":[]}',
           'pending'
         )`
      ).run()

      reconcileInboxMembership(db, 'test@example.com', [])

      expect(db.prepare('SELECT label_id FROM thread_labels').all()).toEqual([{ label_id: 'INBOX' }])
      expect(
        JSON.parse(
          (db.prepare('SELECT labels_json FROM messages').get() as { labels_json: string }).labels_json
        )
      ).toEqual(['STARRED', 'INBOX'])
      expect(db.prepare('SELECT thread_id, state FROM action_queue').all()).toEqual([
        { thread_id: 'pending', state: 'pending' }
      ])
    } finally {
      db.close()
    }
  })

  it('verifies purge candidates individually: refetch persists, 404 deletes', async () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('SELECT thread_id FROM thread_labels')) {
            return [{ thread_id: 'relabeled' }, { thread_id: 'purged' }, { thread_id: 'listed' }]
          }
          return []
        },
        run: () => ({ changes: 1 })
      }),
      transaction: (fn: () => void) => fn
    } as unknown as Db
    const provider = providerFor([])
    vi.mocked(provider.getThread)
      .mockResolvedValueOnce({ id: 'relabeled', messages: [] })
      .mockRejectedValueOnce(new GmailApiError(404, 'gone'))
    const persist = vi.fn(async () => {})
    const remove = vi.fn()

    await reconcilePurgeableMembership(db, 'test@example.com', provider, 'TRASH', ['listed'], {
      persist,
      remove
    })

    // A thread absent from the Trash listing is never deleted on that signal
    // alone — only a direct 404 proves the purge.
    expect(provider.getThread).toHaveBeenCalledTimes(2)
    expect(provider.getThread).toHaveBeenNthCalledWith(1, 'relabeled', {
      format: 'metadata',
      priority: 'background'
    })
    expect(persist).toHaveBeenCalledWith({ id: 'relabeled', messages: [] })
    expect(remove).toHaveBeenCalledWith('purged')
  })
})

describe('history poller lifecycle', () => {
  it('reports healthy empty cycles without broadcasting a mail change', async () => {
    const syncLabels = vi.fn(async () => false)
    const options = pollerOptions({ syncLabels })
    const poller = new HistoryPoller(options)
    const onStarted = vi.fn()
    poller.start()
    expect(poller.requestRunNow(onStarted)).toBe('started')
    expect(onStarted).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(options.onCycleComplete).toHaveBeenCalledOnce())
    expect(syncLabels).toHaveBeenCalledOnce()
    expect(options.onCycleComplete).toHaveBeenCalledWith(false)
    poller.stop()
  })

  it('sweeps drafts before completing a cycle and reports inbound changes', async () => {
    const syncDrafts = vi.fn(async () => true)
    const options = pollerOptions({ syncDrafts })
    const poller = new HistoryPoller(options)
    poller.start()

    await poller.runNow()

    expect(syncDrafts).toHaveBeenCalledOnce()
    expect(options.onCycleComplete).toHaveBeenCalledWith(true)
    poller.stop()
  })

  it('refreshes labels once after history and reports a catalog change', async () => {
    const calls: string[] = []
    const runCycle = vi.fn(async () => {
      calls.push('history')
      return plan()
    })
    const syncLabels = vi.fn(async () => {
      calls.push('labels')
      return true
    })
    const options = pollerOptions({ runCycle, syncLabels })
    const poller = new HistoryPoller(options)
    poller.start()

    await poller.runNow()

    expect(syncLabels).toHaveBeenCalledOnce()
    expect(calls).toEqual(['history', 'labels'])
    expect(options.onCycleComplete).toHaveBeenCalledWith(true)
    poller.stop()
  })

  it('keeps a label-list failure out of the mail-poll error path', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const syncDrafts = vi.fn(async () => false)
    const options = pollerOptions({
      syncLabels: vi.fn(async () => Promise.reject(new Error('labels down'))),
      syncDrafts
    })
    const poller = new HistoryPoller(options)
    poller.start()

    await poller.runNow()

    expect(options.onError).not.toHaveBeenCalled()
    expect(syncDrafts).toHaveBeenCalledOnce()
    expect(options.onCycleComplete).toHaveBeenCalledWith(false)
    expect(warning).toHaveBeenCalledWith('[sync] label catalog refresh failed: labels down')
    warning.mockRestore()
    poller.stop()
  })

  it('keeps a draft-list failure out of the mail-poll error path', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const options = pollerOptions({ syncDrafts: vi.fn(async () => Promise.reject(new Error('drafts down'))) })
    const poller = new HistoryPoller(options)
    poller.start()

    await poller.runNow()

    expect(options.onError).not.toHaveBeenCalled()
    expect(options.onCycleComplete).toHaveBeenCalledWith(false)
    expect(warning).toHaveBeenCalledWith('[draft] inbound sync failed: drafts down')
    warning.mockRestore()
    poller.stop()
  })

  it('resumes a failed expiry recovery without replacing its fresh checkpoint', async () => {
    const recover = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const options = pollerOptions({
      runCycle: vi.fn(async () => {
        throw new GmailApiError(404, 'expired')
      }),
      recoverExpiredHistory: recover
    })
    const poller = new HistoryPoller(options)
    poller.start()

    await poller.runNow()
    await poller.runNow()

    expect(recover).toHaveBeenCalledTimes(2)
    expect(options.onError).toHaveBeenCalledOnce()
    expect(options.onCycleComplete).toHaveBeenCalledWith(true)
    poller.stop()
  })

  it('suppresses completion after stop while a cycle is in flight', async () => {
    let finish: ((value: FetchedHistoryPlan) => void) | undefined
    const options = pollerOptions({
      runCycle: vi.fn(() => new Promise<FetchedHistoryPlan>((resolve) => (finish = resolve)))
    })
    const poller = new HistoryPoller(options)
    poller.start()
    const running = poller.runNow()
    poller.stop()
    finish?.(plan(['changed']))
    await running
    expect(options.onCycleComplete).not.toHaveBeenCalled()
  })

  it('queues a requested retry and reports start only when the follow-up cycle begins', async () => {
    const finishes: Array<(value: FetchedHistoryPlan) => void> = []
    const options = pollerOptions({
      runCycle: vi.fn(() => new Promise<FetchedHistoryPlan>((resolve) => finishes.push(resolve)))
    })
    const poller = new HistoryPoller(options)
    const onRetryStarted = vi.fn()
    poller.start()

    const firstCycle = poller.runNow()
    expect(poller.requestRunNow(onRetryStarted)).toBe('queued')
    expect(onRetryStarted).not.toHaveBeenCalled()

    finishes[0]?.(plan())
    await firstCycle
    await vi.waitFor(() => expect(options.runCycle).toHaveBeenCalledTimes(2))
    expect(onRetryStarted).toHaveBeenCalledOnce()

    finishes[1]?.(plan())
    await vi.waitFor(() => expect(options.onCycleComplete).toHaveBeenCalledTimes(2))
    poller.stop()
  })

  it('uses 15-second foreground and 60-second background cadence', async () => {
    vi.useFakeTimers()
    const foreground = pollerOptions()
    const background = pollerOptions({ isForeground: () => false })
    const foregroundPoller = new HistoryPoller(foreground)
    const backgroundPoller = new HistoryPoller(background)
    foregroundPoller.start()
    backgroundPoller.start()

    await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_MS)
    expect(foreground.runCycle).toHaveBeenCalledOnce()
    expect(background.runCycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS - FOREGROUND_POLL_MS)
    expect(background.runCycle).toHaveBeenCalledOnce()
    foregroundPoller.stop()
    backgroundPoller.stop()
  })
})

describe('INBOX reconciliation helper', () => {
  it('returns local ids absent from the server set', () => {
    expect(missingInboxThreadIds(['a', 'b', 'b', 'c'], ['b', 'd'])).toEqual(['a', 'c'])
  })
})
