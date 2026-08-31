import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import { SEARCH_RECENT_MESSAGE_LIMIT, SEARCH_RESULT_LIMIT, searchThreads } from '../db/search'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { ensureAccount, persistThread } from './persist'
import {
  newServerThreadIds,
  type ServerSearchProvider,
  searchAllGmail,
  serverSearchFailure
} from './serverSearch'

const ACCOUNT = 'search@example.test'

function thread(id: string, at: number, labelIds: string[] = ['INBOX']): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds,
        internalDate: String(at),
        snippet: `Remote match ${id}`,
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: `${id} <${id}@example.test>` },
            { name: 'To', value: ACCOUNT },
            { name: 'Subject', value: `Remote match ${id}` }
          ],
          body: { data: Buffer.from(`Remote match ${id}`).toString('base64url') }
        }
      }
    ]
  }
}

describe('newServerThreadIds', () => {
  it('keeps Gmail order while removing local and repeated ids', () => {
    expect(
      newServerThreadIds(['local', 'also-local'], ['local', 'remote-b', 'remote-b', 'remote-a'])
    ).toEqual(['remote-b', 'remote-a'])
  })
})

describe('searchAllGmail', () => {
  it('fetches, persists, orders, and dedupes server-only matches', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      persistThread(db, ACCOUNT, thread('local', 400))
      let waitMs = 0
      const snapshots = new Map([
        ['remote-b', thread('remote-b', 200)],
        ['remote-a', thread('remote-a', 300)]
      ])
      const provider: ServerSearchProvider = {
        listThreadIds: vi
          .fn()
          .mockImplementationOnce(async () => {
            waitMs = 1_250
            return {
              threadIds: ['local', 'remote-b', 'remote-b', 'gone'],
              nextPageToken: 'page-2'
            }
          })
          .mockResolvedValueOnce({ threadIds: ['local', 'gone', 'remote-a'] }),
        getThread: vi.fn(async (id) => {
          if (id === 'gone') throw new GmailApiError(404, 'gone')
          const snapshot = snapshots.get(id)
          if (!snapshot) throw new Error(`unexpected thread ${id}`)
          return snapshot
        }),
        getAttachmentData: vi.fn(async () => undefined),
        quotaMetrics: () => ({ requests: 0, units: 0, waitMs })
      }

      const result = await searchAllGmail(db, ACCOUNT, provider, 'remote')

      expect(provider.listThreadIds).toHaveBeenNthCalledWith(1, {
        q: 'remote -in:drafts',
        includeSpamTrash: false,
        priority: 'foreground'
      })
      expect(provider.listThreadIds).toHaveBeenNthCalledWith(2, {
        q: 'remote -in:drafts',
        includeSpamTrash: false,
        priority: 'foreground',
        pageToken: 'page-2'
      })
      expect(provider.getThread).toHaveBeenCalledTimes(3)
      expect(provider.getThread).not.toHaveBeenCalledWith('local', expect.anything())
      expect(result.rows.map((row) => row.id)).toEqual(['remote-b', 'remote-a'])
      expect(result.quotaWaitMs).toBe(1_250)
      expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 3 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 3 })
    } finally {
      db.close()
    }
  })

  it('uses the stored label name in the Gmail query', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      db.prepare(
        "INSERT INTO labels (account_id, id, name, type) VALUES (?, 'Label_Project', 'Project Alpha', 'user')"
      ).run(ACCOUNT)
      const provider: ServerSearchProvider = {
        listThreadIds: vi.fn(async () => ({ threadIds: [] })),
        getThread: vi.fn(),
        getAttachmentData: vi.fn()
      }

      await searchAllGmail(db, ACCOUNT, provider, 'in:Label_Project')

      expect(provider.listThreadIds).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'label:"Project Alpha" -in:drafts' })
      )
    } finally {
      db.close()
    }
  })

  it('returns cached matches beyond the visible local result limit without refetching them', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const localIds = Array.from({ length: SEARCH_RESULT_LIMIT * 2 }, (_, index) => `local-${index}`)
      for (const [index, id] of localIds.entries()) {
        persistThread(db, ACCOUNT, thread(id, 10_000 - index))
      }
      const overflowLocalIds = localIds.slice(SEARCH_RESULT_LIMIT)
      const remote = thread('remote-after-local-page', 20_000)
      const provider: ServerSearchProvider = {
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({ threadIds: overflowLocalIds, nextPageToken: 'page-2' })
          .mockResolvedValueOnce({ threadIds: [remote.id] }),
        getThread: vi.fn(async (id) => {
          if (id !== remote.id) throw new Error(`unexpected refetch of local thread ${id}`)
          return remote
        }),
        getAttachmentData: vi.fn(async () => undefined)
      }

      const result = await searchAllGmail(db, ACCOUNT, provider, 'Remote')

      expect(provider.listThreadIds).toHaveBeenCalledOnce()
      expect(provider.getThread).not.toHaveBeenCalled()
      expect(result.rows.map((row) => row.id)).toEqual(overflowLocalIds)
    } finally {
      db.close()
    }
  })

  it('finds a cached old match outside the recency window and dedupes it across Gmail pages', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const old = thread('old-invoice', Date.UTC(2010, 0, 1))
      for (const message of old.messages ?? []) {
        if (message.payload) delete message.payload.body
      }
      const remote = thread('uncached-invoice', Date.UTC(2009, 0, 1))
      db.transaction(() => {
        persistThread(db, ACCOUNT, old, { metadataOnly: true })
        for (let index = 0; index < SEARCH_RECENT_MESSAGE_LIMIT; index++) {
          persistThread(db, ACCOUNT, thread(`recent-${index}`, Date.UTC(2026, 0, 1) + index))
        }
      })()
      const query = 'remote before:2011-01-01'
      expect(searchThreads(db, ACCOUNT, query)).toMatchObject({ rows: [], partial: true })
      const provider: ServerSearchProvider = {
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({ threadIds: [old.id, old.id], nextPageToken: 'page-2' })
          .mockResolvedValueOnce({ threadIds: [old.id, remote.id] }),
        getThread: vi.fn(async (id) => {
          if (id !== remote.id) throw new Error(`unexpected refetch of cached thread ${id}`)
          return remote
        }),
        getAttachmentData: vi.fn(async () => undefined)
      }

      const result = await searchAllGmail(db, ACCOUNT, provider, query)

      expect(result.rows.map((row) => row.id)).toEqual([old.id, remote.id])
      expect(provider.listThreadIds).toHaveBeenCalledTimes(2)
      expect(provider.getThread).toHaveBeenCalledOnce()
      expect(provider.getThread).toHaveBeenCalledWith(remote.id, expect.objectContaining({ format: 'full' }))
      expect(provider.getAttachmentData).not.toHaveBeenCalled()
      expect(
        db
          .prepare('SELECT body_text, body_html FROM messages WHERE account_id = ? AND thread_id = ?')
          .get(ACCOUNT, old.id)
      ).toEqual({ body_text: '', body_html: null })
    } finally {
      db.close()
    }
  })

  it('does not count non-persisted Gmail snapshots toward the result limit', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const chatIds = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, index) => `chat-${index}`)
      const remote = thread('normal-after-chat-page', 20_000)
      const provider: ServerSearchProvider = {
        listThreadIds: vi
          .fn()
          .mockResolvedValueOnce({ threadIds: chatIds, nextPageToken: 'page-2' })
          .mockResolvedValueOnce({ threadIds: [remote.id] }),
        getThread: vi.fn(async (id) => (id === remote.id ? remote : thread(id, 10_000, ['CHAT']))),
        getAttachmentData: vi.fn(async () => undefined)
      }

      const result = await searchAllGmail(db, ACCOUNT, provider, 'Remote')

      expect(provider.listThreadIds).toHaveBeenCalledTimes(2)
      expect(provider.getThread).toHaveBeenCalledTimes(SEARCH_RESULT_LIMIT + 1)
      expect(result.rows.map((row) => row.id)).toEqual([remote.id])
    } finally {
      db.close()
    }
  })

  it.each(['is:snoozed', 'in:snoozed', 'in:drafts subject:budget'])(
    'keeps local-only state out of Gmail search for %s',
    async (query) => {
      const db = openDatabase(':memory:')
      try {
        ensureAccount(db, ACCOUNT, ACCOUNT)
        const provider: ServerSearchProvider = {
          listThreadIds: vi.fn(),
          getThread: vi.fn(),
          getAttachmentData: vi.fn()
        }

        await expect(searchAllGmail(db, ACCOUNT, provider, query)).resolves.toEqual({
          rows: [],
          quotaWaitMs: 0
        })
        expect(provider.listThreadIds).not.toHaveBeenCalled()
        expect(provider.getThread).not.toHaveBeenCalled()
      } finally {
        db.close()
      }
    }
  )

  it('does not expand a quote-only query into a mailbox-wide Gmail search', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const provider: ServerSearchProvider = {
        listThreadIds: vi.fn(),
        getThread: vi.fn(),
        getAttachmentData: vi.fn()
      }

      await expect(searchAllGmail(db, ACCOUNT, provider, '""')).resolves.toEqual({
        rows: [],
        quotaWaitMs: 0
      })
      expect(provider.listThreadIds).not.toHaveBeenCalled()
      expect(provider.getThread).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('hydrates and indexes out-of-line text bodies before returning a durable result', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const controller = new AbortController()
      const remote: GmailThread = {
        id: 'external-body',
        messages: [
          {
            id: 'message-external-body',
            threadId: 'external-body',
            labelIds: ['INBOX'],
            internalDate: '500',
            snippet: 'A remotely matched conversation',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'Sender <sender@example.test>' },
                { name: 'To', value: ACCOUNT },
                { name: 'Subject', value: 'A remotely matched conversation' }
              ],
              body: { attachmentId: 'large-text-part', size: 4_096 }
            }
          }
        ]
      }
      const provider: ServerSearchProvider = {
        listThreadIds: vi.fn(async () => ({ threadIds: [remote.id] })),
        getThread: vi.fn(async () => remote),
        getAttachmentData: vi.fn(async () =>
          Buffer.from('The durable-body-token is only in this large body.').toString('base64url')
        )
      }

      const result = await searchAllGmail(db, ACCOUNT, provider, 'durable-body-token', {
        signal: controller.signal
      })

      expect(result.rows.map((row) => row.id)).toEqual([remote.id])
      expect(searchThreads(db, ACCOUNT, 'durable-body-token').rows.map((row) => row.id)).toEqual([remote.id])
      expect(provider.listThreadIds).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal, priority: 'foreground' })
      )
      expect(provider.getThread).toHaveBeenCalledWith(remote.id, {
        format: 'full',
        signal: controller.signal,
        priority: 'foreground'
      })
      expect(provider.getAttachmentData).toHaveBeenCalledWith('message-external-body', 'large-text-part', {
        signal: controller.signal,
        priority: 'foreground'
      })
    } finally {
      db.close()
    }
  })

  it('stops before fetching threads when a listing is superseded', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const controller = new AbortController()
      const provider: ServerSearchProvider = {
        listThreadIds: vi.fn(async () => {
          controller.abort()
          return { threadIds: ['stale-result'] }
        }),
        getThread: vi.fn(),
        getAttachmentData: vi.fn()
      }

      await expect(
        searchAllGmail(db, ACCOUNT, provider, 'stale', { signal: controller.signal })
      ).resolves.toEqual({ rows: [], quotaWaitMs: 0 })
      expect(provider.getThread).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})

describe('serverSearchFailure', () => {
  it('keeps reconnect, offline, and transient failures distinct', () => {
    expect(serverSearchFailure(new GmailAuthError('expired')).status).toBe('auth-required')
    expect(serverSearchFailure(new Error('fetch failed'))).toEqual({
      status: 'offline',
      message: 'Search Gmail when you are back online'
    })
    expect(serverSearchFailure(new GmailApiError(429, 'quota', true))).toEqual({
      status: 'error',
      message: 'Gmail is busy. Try the search again.'
    })
  })
})
