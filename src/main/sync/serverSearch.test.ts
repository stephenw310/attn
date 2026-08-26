import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import { searchThreads } from '../db/search'
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

function thread(id: string, at: number): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds: ['INBOX'],
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

  it.each(['is:snoozed', 'in:snoozed'])('does not substitute Gmail snooze state for %s', async (query) => {
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
