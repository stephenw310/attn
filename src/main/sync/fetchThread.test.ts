import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { fetchAndCacheThread } from './fetchThread'
import { ensureAccount } from './persist'

const ACCOUNT = 'fetch@example.test'

function thread(id: string): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds: ['INBOX'],
        internalDate: '100',
        snippet: 'Cached once',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Remote Sender <remote@example.test>' },
            { name: 'To', value: ACCOUNT },
            { name: 'Subject', value: 'Remote thread' }
          ],
          body: { data: Buffer.from('Remote body').toString('base64url') }
        }
      }
    ]
  }
}

describe('fetchAndCacheThread', () => {
  it('uses foreground quota priority and persists repeated snapshots without duplicate rows', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const snapshot = thread('remote')
      const provider = { getThread: vi.fn(async () => snapshot) }

      await expect(fetchAndCacheThread(db, ACCOUNT, provider, 'remote')).resolves.toBe(snapshot)
      await fetchAndCacheThread(db, ACCOUNT, provider, 'remote')

      expect(provider.getThread).toHaveBeenNthCalledWith(1, 'remote', {
        format: 'full',
        priority: 'foreground'
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it.each([
    ['a missing thread', new GmailApiError(404, 'gone')],
    ['a transient failure', new GmailApiError(503, 'try again', true)]
  ])('does not persist %s', async (_label, error) => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const provider = { getThread: vi.fn(async () => Promise.reject(error)) }

      await expect(fetchAndCacheThread(db, ACCOUNT, provider, 'remote')).rejects.toBe(error)
      expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('marks metadata requests so they cannot erase cached attachment details', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      const snapshot = thread('metadata')
      const provider = { getThread: vi.fn(async () => snapshot) }

      await fetchAndCacheThread(db, ACCOUNT, provider, 'metadata', { format: 'metadata' })

      expect(provider.getThread).toHaveBeenCalledWith('metadata', {
        format: 'metadata',
        priority: 'foreground'
      })
    } finally {
      db.close()
    }
  })

  it('does not persist a response after its account is superseded', async () => {
    const db = openDatabase(':memory:')
    try {
      ensureAccount(db, ACCOUNT, ACCOUNT)
      let current = true
      const provider = {
        getThread: vi.fn(async () => {
          current = false
          return thread('superseded')
        })
      }

      await fetchAndCacheThread(db, ACCOUNT, provider, 'superseded', {
        shouldPersist: () => current
      })

      expect(db.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })
})
