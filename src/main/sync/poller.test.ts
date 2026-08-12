import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { fetchHistoryPlan, missingInboxThreadIds, planCycle } from './poller'
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
    getThread: vi.fn(async () => ({ id: 'unused' })),
    listHistory: vi.fn(async () => pages[page++])
  }
}

describe('history cycle planner', () => {
  it('dedupes every affected thread and identifies only inbound unread mail', () => {
    expect(planCycle(fixture)).toEqual({
      refetchThreadIds: ['t-label', 't-deleted', 't-inbound', 't-self', 't-read'],
      newMail: [{ threadId: 't-inbound', messageId: 'm-inbound' }]
    })
  })

  it('combines mixed pages through a mock MailProvider and preserves 64-bit history ids', async () => {
    const provider = providerFor([
      {
        history: fixture.slice(0, 2),
        historyId: '9007199254740994',
        nextPageToken: 'page-2'
      },
      { history: fixture.slice(2), historyId: '9007199254740996' }
    ])

    const result = await fetchHistoryPlan(provider, '9007199254740992')

    expect(provider.listHistory).toHaveBeenNthCalledWith(1, '9007199254740992', undefined)
    expect(provider.listHistory).toHaveBeenNthCalledWith(2, '9007199254740992', 'page-2')
    expect(result.historyId).toBe('9007199254740996')
    expect(result.refetchThreadIds).toEqual(['t-label', 't-deleted', 't-inbound', 't-self', 't-read'])
    expect(result.newMail).toEqual([{ threadId: 't-inbound', messageId: 'm-inbound' }])
  })
})

describe('INBOX reconciliation', () => {
  it('returns local INBOX ids absent from the complete server set', () => {
    expect(missingInboxThreadIds(['a', 'b', 'b', 'c'], ['b', 'd'])).toEqual(['a', 'c'])
  })
})
