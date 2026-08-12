import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
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
    listHistory: vi.fn(async () => pages[page++])
  }
}

function plan(refetchThreadIds: string[] = []): FetchedHistoryPlan {
  return { historyId: '11', refetchThreadIds, newMail: [] }
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
      newMail: [{ threadId: 't-inbound', messageId: 'm-inbound' }]
    })
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
})

describe('history poller lifecycle', () => {
  it('reports healthy empty cycles without broadcasting a mail change', async () => {
    const options = pollerOptions()
    const poller = new HistoryPoller(options)
    poller.start()
    await poller.runNow()
    expect(options.onCycleComplete).toHaveBeenCalledWith(false)
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
